/// <reference types="vite/client" />

/** package.json 版本号(vite define 注入) */
declare const __APP_VERSION__: string

declare module 'three' {
  export class CanvasTexture {
    constructor(canvas: HTMLCanvasElement)
  }

  export class Object3D {
    position: object
    userData: Record<string, unknown>
    visible: boolean
  }

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number)
    x: number
    y: number
    z: number
    project(camera: object): Vector3
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
