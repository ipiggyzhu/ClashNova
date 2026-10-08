# Service, TUN, and Traffic Reference Notes

> **历史参考实现笔记。** 以下方案、完成标记与环境/验证描述保留原始上下文，不代表当前代码或本轮验证结果。
> 当前技术栈及构建流程见 [BUILD.md](../BUILD.md)，实际依赖以锁文件为准。


This fix was checked against `/mnt/d/code/clash-verge-rev-ref`.

Relevant reference points:

- `src-tauri/src/core/service.rs`: `wait_for_service_ipc` waits for the service IPC path and connection with retry before marking the service ready.
- `src-tauri/src/core/manager/lifecycle.rs`: TUN service startup treats a missing IPC path as a transient condition and retries instead of immediately forcing reinstall.
- `src/hooks/use-traffic-data.ts`: traffic WebSocket frames are guarded against very short-window duplicates before updating UI state.
- `src-tauri/src/cmd/network.rs`: the reference app exposes network interface data for UI diagnostics, which supports adding ClashNova's TUN adapter detection command.

ClashNova applies the same behavior at a smaller scope: service IPC startup is reported as a temporary unavailable state, TUN enable waits for both runtime config and virtual adapter presence, and realtime speed falls back to connection total deltas when `/traffic` is stale or disconnected.
