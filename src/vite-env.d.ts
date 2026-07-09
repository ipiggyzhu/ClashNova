/// <reference types="vite/client" />

/** package.json 版本号(vite define 注入) */
declare const __APP_VERSION__: string

declare module 'three' {
  export const SRGBColorSpace: string
  export const NoColorSpace: string
  export const LinearFilter: number
  export const LinearMipmapLinearFilter: number

  export class Texture {
    colorSpace: string
    needsUpdate: boolean
    anisotropy: number
    minFilter: number
    magFilter: number
    generateMipmaps: boolean
  }

  export class CanvasTexture extends Texture {
    constructor(canvas: HTMLCanvasElement)
  }

  export class TextureLoader {
    loadAsync(url: string): Promise<Texture>
  }

  export class Object3D {
    position: object
    userData: Record<string, unknown>
    visible: boolean
  }

  export class Vector2 {
    constructor(x?: number, y?: number)
    x: number
    y: number
    set(x: number, y: number): Vector2
  }

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number)
    x: number
    y: number
    z: number
    project(camera: object): Vector3
  }

  export class ShaderMaterial {
    constructor(params?: Record<string, unknown>)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uniforms: Record<string, { value: any }>
    needsUpdate: boolean
  }

  export class SpriteMaterial {
    constructor(params?: Record<string, unknown>)
    rotation: number
  }

  export class Sprite extends Object3D {
    constructor(material?: SpriteMaterial)
    material: SpriteMaterial
    scale: { set(x: number, y: number, z: number): void }
  }
}
