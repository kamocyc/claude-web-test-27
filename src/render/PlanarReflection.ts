import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  Plane,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { WATER_LEVEL } from '../core/config'

const _normal = new Vector3(0, 1, 0)
const _reflectorPosition = new Vector3(0, WATER_LEVEL, 0)
const _cameraPosition = new Vector3()
const _rotation = new Matrix4()
const _lookAt = new Vector3()
const _view = new Vector3()
const _target = new Vector3()
const _plane = new Plane()
const _clip = new Vector4()
const _q = new Vector4()

/**
 * Mirror reflection of the scene in the water plane.
 *
 * The virtual camera is built the way three's own Reflector builds it: an
 * ordinary camera placed at the mirrored position, looking at the mirrored
 * target, with a mirrored up vector. That keeps its transform right-handed, so
 * triangle winding — and therefore back-face culling — still works. Building it
 * instead by multiplying the camera's world matrix by a reflection matrix is
 * the more obvious construction, but it has a negative determinant: every face
 * turns inside out and the reflection has to be rescued with a cull-face hack
 * that fights the renderer's own state cache.
 *
 * The resulting image is mirrored left to right relative to the real view. The
 * projective texture matrix handles that: the water shader looks its own world
 * position up through the virtual camera's projection rather than reusing
 * screen UVs, which also keeps the reflection anchored as waves displace the
 * surface.
 *
 * The near plane is skewed onto the water (Lengyel's oblique frustum) so
 * nothing below the surface leaks into the sky.
 */
export class PlanarReflection {
  readonly textureMatrix = new Matrix4()
  private readonly target: WebGLRenderTarget
  private readonly virtualCamera = new PerspectiveCamera()

  /** Small push away from the water plane, to stop z-fighting at the horizon. */
  clipBias = 0.004
  /** Set false to skip the extra scene pass on low quality settings. */
  enabled = true

  constructor(width: number, height: number) {
    this.target = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    })
  }

  get texture(): Texture {
    return this.target.texture
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(2, width), Math.max(2, height))
  }

  /**
   * Render the mirrored scene.
   *
   * `hidden` is toggled invisible for the pass — pass the water surface itself,
   * which must not appear in its own mirror, along with anything else that
   * would be wrong to reflect.
   */
  render(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    hidden: { visible: boolean }[],
  ): void {
    if (!this.enabled) return

    _cameraPosition.setFromMatrixPosition(camera.matrixWorld)
    // Looking at the surface from underneath: there is nothing to mirror.
    if (_cameraPosition.y < WATER_LEVEL) return

    this.updateVirtualCamera(camera)

    const wasVisible = hidden.map((object) => object.visible)
    for (const object of hidden) object.visible = false

    const previousTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    renderer.render(scene, this.virtualCamera)
    renderer.setRenderTarget(previousTarget)

    hidden.forEach((object, i) => {
      object.visible = wasVisible[i]!
    })
  }

  private updateVirtualCamera(camera: PerspectiveCamera): void {
    // Mirror the eye point through the water plane.
    _view.subVectors(_reflectorPosition, _cameraPosition)
    _view.reflect(_normal).negate().add(_reflectorPosition)

    _rotation.extractRotation(camera.matrixWorld)
    _lookAt.set(0, 0, -1).applyMatrix4(_rotation).add(_cameraPosition)

    // ... and the point it is looking at.
    _target.subVectors(_reflectorPosition, _lookAt)
    _target.reflect(_normal).negate().add(_reflectorPosition)

    const virtual = this.virtualCamera
    virtual.position.copy(_view)
    virtual.up.set(0, 1, 0).applyMatrix4(_rotation).reflect(_normal)
    virtual.lookAt(_target)
    virtual.near = camera.near
    virtual.far = camera.far
    virtual.updateMatrixWorld()
    virtual.projectionMatrix.copy(camera.projectionMatrix)

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    this.textureMatrix.multiply(virtual.projectionMatrix)
    this.textureMatrix.multiply(virtual.matrixWorldInverse)

    this.applyObliqueNearPlane()
  }

  /** Lengyel's oblique frustum: move the near plane onto the water surface. */
  private applyObliqueNearPlane(): void {
    const virtual = this.virtualCamera
    _plane.setFromNormalAndCoplanarPoint(_normal, _reflectorPosition)
    _plane.applyMatrix4(virtual.matrixWorldInverse)
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant)

    const m = virtual.projectionMatrix.elements
    _q.set(
      (Math.sign(_clip.x) + m[8]!) / m[0]!,
      (Math.sign(_clip.y) + m[9]!) / m[5]!,
      -1,
      (1 + m[10]!) / m[14]!,
    )
    _clip.multiplyScalar(2 / _clip.dot(_q))

    m[2] = _clip.x
    m[6] = _clip.y
    m[10] = _clip.z + 1 - this.clipBias
    m[14] = _clip.w
  }

  dispose(): void {
    this.target.dispose()
  }
}
