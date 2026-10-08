//! 服务权限边界: 安装时绑定配置目录, 只运行受保护目录内的固定内核。

use crate::CoreConfig;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

pub const MANAGED_CORE_NAME: &str = "mihomo.exe";

#[cfg(windows)]
pub fn managed_service_directory() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        .join("ClashNova")
        .join("service")
}

#[derive(Clone)]
pub struct ServicePolicy {
    core_path: PathBuf,
    config_dir: PathBuf,
    #[cfg(windows)]
    client_sid: String,
}

fn checked_path(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("服务路径必须为绝对路径");
    }
    // 配置所属用户也不能通过 junction/symlink 将绑定目录指向其他位置。
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)
            .with_context(|| format!("检查服务路径失败: {}", ancestor.display()))?;
        if metadata.file_type().is_symlink() {
            bail!("服务路径不接受符号链接");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                bail!("服务路径不接受重解析点");
            }
        }
    }
    std::fs::canonicalize(path).context("规范化服务路径失败")
}

impl ServicePolicy {
    #[cfg(windows)]
    pub fn from_installation(config_dir: &Path) -> Result<Self> {
        let service_dir = checked_path(&managed_service_directory())?;
        let executable = checked_path(&std::env::current_exe()?)?;
        if executable.parent() != Some(service_dir.as_path()) {
            bail!("服务必须从受保护的安装目录启动，请重新安装服务");
        }
        let config_dir = checked_path(config_dir)?;
        let client_sid = windows_security::owner_sid(&config_dir)?;
        Ok(Self {
            core_path: checked_path(&service_dir.join(MANAGED_CORE_NAME))?,
            config_dir,
            client_sid,
        })
    }

    pub(crate) fn validate(&self, config: &CoreConfig) -> Result<()> {
        if checked_path(Path::new(&config.core_path))? != self.core_path {
            bail!("服务仅允许启动安装目录中的 mihomo 内核");
        }
        if checked_path(Path::new(&config.config_dir))? != self.config_dir
            || checked_path(Path::new(&config.config_path))? != self.config_dir.join("runtime.yaml")
        {
            bail!("内核配置不属于服务安装时绑定的目录");
        }
        if !self.core_path.is_file() || !Path::new(&config.config_path).is_file() {
            bail!("内核或配置路径不是普通文件");
        }
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn pipe_security(&self) -> Result<windows_security::SecurityDescriptor> {
        // 只授予读和写数据权限, 不授予 FILE_CREATE_PIPE_INSTANCE (0x4)。
        windows_security::SecurityDescriptor::from_sddl(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12008b;;;{})",
            self.client_sid
        ))
    }
}

#[cfg(windows)]
pub mod windows_security {
    use super::*;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{LocalFree, BOOL, ERROR_SUCCESS, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PSID, SECURITY_ATTRIBUTES,
    };

    pub(crate) struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(HLOCAL(self.0 .0));
            }
        }
    }

    impl SecurityDescriptor {
        pub(crate) fn from_sddl(sddl: &str) -> Result<Self> {
            let text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(text.as_ptr()),
                    1,
                    &mut descriptor,
                    None,
                )?;
            }
            Ok(Self(descriptor))
        }

        pub(crate) fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.0 .0,
                bInheritHandle: false.into(),
            }
        }
    }

    pub(super) fn owner_sid(path: &Path) -> Result<String> {
        use std::os::windows::ffi::OsStrExt;
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut owner = PSID::default();
        let mut raw = PSECURITY_DESCRIPTOR::default();
        let result = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                None,
                None,
                &mut raw,
            )
        };
        let _descriptor = SecurityDescriptor(raw);
        if result != ERROR_SUCCESS {
            bail!("读取配置目录所有者失败: {}", result.0);
        }
        let mut sid = PWSTR::null();
        unsafe {
            ConvertSidToStringSidW(owner, &mut sid)?;
        }
        let text = unsafe { sid.to_string() };
        unsafe {
            let _ = LocalFree(HLOCAL(sid.0.cast()));
        }
        text.context("读取配置目录所有者 SID 失败")
    }

    /// 服务日志只写入安装阶段创建的受保护目录, 不以 SYSTEM 权限跟随用户日志路径。
    pub fn open_service_log() -> Result<std::fs::File> {
        let service_dir = checked_path(&managed_service_directory())?;
        if checked_path(&std::env::current_exe()?)?.parent() != Some(service_dir.as_path()) {
            bail!("服务日志仅供受保护安装目录中的服务使用");
        }
        let log_dir = checked_path(&service_dir.join("logs"))?;
        let log_path = log_dir.join("clashnova-service.log");
        match std::fs::symlink_metadata(&log_path) {
            Ok(_) => {
                checked_path(&log_path)?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err).context("检查服务日志失败"),
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .context("打开受保护服务日志失败")
    }

    /// 仅由提权安装助手调用; 普通用户对服务及内核二进制只能读取/执行。
    pub fn protect_installation_path(path: &Path) -> Result<()> {
        use std::os::windows::ffi::OsStrExt;
        checked_path(path)?;
        let descriptor = SecurityDescriptor::from_sddl(
            "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)",
        )?;
        let mut owner = PSID::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut present = BOOL::default();
        let mut defaulted = BOOL::default();
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            GetSecurityDescriptorOwner(descriptor.0, &mut owner, &mut defaulted)?;
            GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted)?;
            let result = SetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                owner,
                PSID::default(),
                Some(dacl),
                None,
            );
            if result != ERROR_SUCCESS {
                bail!("设置服务安装目录权限失败: {}", result.0);
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::Security::{GetAce, ACCESS_ALLOWED_ACE};
        use windows::Win32::Storage::FileSystem::{
            FILE_CREATE_PIPE_INSTANCE, FILE_GENERIC_READ, FILE_WRITE_DATA,
        };

        #[test]
        fn client_acl_allows_data_io_without_creating_pipe_instances() {
            let policy = ServicePolicy {
                core_path: PathBuf::new(),
                config_dir: PathBuf::new(),
                client_sid: "S-1-5-21-1-2-3-1001".into(),
            };
            let descriptor = policy.pipe_security().unwrap();
            let mut dacl = std::ptr::null_mut();
            let mut present = BOOL::default();
            let mut defaulted = BOOL::default();
            unsafe {
                GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted)
                    .unwrap();
                assert!(present.as_bool());
                assert!(!dacl.is_null());
                assert_eq!((*dacl).AceCount, 3);
                let mut ace = std::ptr::null_mut();
                GetAce(dacl, 2, &mut ace).unwrap();
                let mask = (*ace.cast::<ACCESS_ALLOWED_ACE>()).Mask;
                assert_eq!(mask & FILE_GENERIC_READ.0, FILE_GENERIC_READ.0);
                assert_ne!(mask & FILE_WRITE_DATA.0, 0);
                assert_eq!(mask & FILE_CREATE_PIPE_INSTANCE.0, 0);
            }
        }

        #[test]
        fn relative_service_paths_are_rejected_before_filesystem_access() {
            assert!(checked_path(Path::new("relative/mihomo.exe")).is_err());
        }
    }
}
