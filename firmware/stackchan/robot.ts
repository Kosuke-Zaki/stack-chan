import Timer from 'timer'
import { Vector3, Pose, Rotation, Maybe, noop, randomBetween, type MotionOptions } from 'stackchan-util'
import { type FaceContext, type Emotion, createFaceContext, FaceDecorator } from 'renderer-base'
import Digital from 'embedded:io/digital'
import Touch from 'touch'
import { createBalloonDecorator } from 'decorator'
import { DEFAULT_FONT } from 'consts'
import Resource from 'Resource'
import parseBMF from 'commodetto/parseBMF'
import TextDecoder from 'text/decoder'

const INTERVAL_FACE = 1000 / 30
const INTERVAL_POSE = 1000 / 10

/**
 * The Driver for the actuator
 */
export type Driver = {
  applyRotation: (ori: Rotation, options?: MotionOptions) => Promise<void>
  getRotation: () => Promise<Maybe<Rotation>>
  setTorque: (torque: boolean) => Promise<void>
  onAttached?: () => void
  onDetached?: () => void
}

/**
 * The text-to-speech engine
 */
export type TTS = {
  stream: (text: string) => Promise<void>
  onPlayed: (volume: number) => void
  onDone: () => void
  setSpeakerId?: (speakerId: number) => void
}

/**
 * The display renderer
 */
export type Renderer = {
  update: (interval: number, faceContext: Readonly<FaceContext>) => void
  addDecorator(decorator: FaceDecorator): void
  removeDecorator(decorator: FaceDecorator): void
}

export type Button = {
  onChanged: (this: Digital) => void
}

const buttonNames = ['a', 'b', 'c'] as const
type ButtonName = typeof buttonNames[number]

/**
 * The constructor parameters of the robot.
 */
type RobotConstructorParam<T extends string> = {
  driver: Driver
  renderer: Renderer
  tts: TTS
  button: { [key in T]: Button }
  pose?: {
    body: Pose
    eyes: {
      left: Pose
      right: Pose
    }
  }
  touch?: Touch
  decoder: TextDecoder
}

const LEFT_RIGHT = Object.freeze(['left', 'right'])
export class Robot {
  /**
   * A Facade class that provides quick access for Stack-chan features
   *
   * @public
   */
  #gazePoint: Vector3
  #pose: {
    body: Pose
    eyes: {
      left: Pose
      right: Pose
    }
  }
  #power: number
  #tts: TTS
  #driver: Driver
  #button: { [key in ButtonName]: Button }
  #touch: Touch
  #isMoving: boolean
  #renderer: Renderer
  #paused: boolean
  #faceContext: FaceContext
  #lastFaceUpdateMs: number
  #emotion: Emotion
  #updatePoseHandler: Timer
  #updateFaceHandler: Timer
  #font: ReturnType<typeof parseBMF>
  #balloon: FaceDecorator
  #decoder: TextDecoder
  updating: boolean
  constructor(params: RobotConstructorParam<ButtonName>) {
    this.useRenderer(params.renderer)
    this.useDriver(params.driver)
    this.useTTS(params.tts)
    this.#isMoving = false
    this.#power = 0
    this.#button = params.button
    this.#touch = params.touch
    this.#decoder = params.decoder
    this.#pose = params.pose ?? {
      body: {
        position: {
          x: 0.0,
          y: 0.0,
          z: 0.0,
        },
        rotation: {
          y: 0.0,
          p: 0.0,
          r: 0.0,
        },
      },
      eyes: {
        left: {
          position: {
            x: 0.03,
            y: 0.009,
            z: 0,
          },
          rotation: {
            r: 0.0,
            p: 0.0,
            y: 0.0,
          },
        },
        right: {
          position: {
            x: 0.03,
            y: -0.009,
            z: 0,
          },
          rotation: {
            r: 0.0,
            p: 0.0,
            y: 0.0,
          },
        },
      },
    }
    this.#updatePoseHandler = Timer.repeat(this.updatePose.bind(this), INTERVAL_POSE)
    this.#updateFaceHandler = Timer.repeat(this.updateFace.bind(this), INTERVAL_FACE)
    this.#paused = false
    this.#faceContext = createFaceContext()
    this.#lastFaceUpdateMs = Date.now()
  }

  /**
   * set a TTS instance to Robot and register callbacks
   *
   * @param tts - TTS class instance
   */
  useTTS(tts: TTS) {
    if (this.#tts != null) {
      this.#tts.onDone = noop
      this.#tts.onPlayed = noop
    }
    this.#tts = tts
    this.#tts.onPlayed = (volume: number) => {
      this.#power = volume
    }
    this.#tts.onDone = () => {
      this.#power = 0
      this.#faceContext.mouth.open = 0
    }
  }

  /**
   * set a Renderer instance to Robot and register callbacks
   *
   * @param renderer - Renderer class instance
   */
  useRenderer(renderer: Renderer) {
    this.#renderer = renderer
  }

  /**
   * set a Driver instance to Robot and register callbacks
   *
   * @param driver - Driver class instance
   */
  useDriver(driver: Driver) {
    if (this.#driver != null) {
      this.#driver.onDetached?.()
    }
    this.#driver = driver
    this.#driver.onAttached?.()
  }

  /**
   * get Buttons
   *
   * @returns Button instances
   */
  get button() {
    return this.#button
  }

  /**
   * get Touch
   *
   * @returns Touch instances
   */
  get touch() {
    return this.#touch
  }

  /**
   * get Pose
   *
   * @returns Button instances
   */
  get pose() {
    return this.#pose
  }

  /**
   * let the robot say things
   *
   * @param text - the key or speech text itself to say
   * @returns the text when speech finishes, otherwise the reason why it fails.
   */
  async say(text: string): Promise<Maybe<string>> {
    return new Promise((resolve, _reject) => {
      this.#tts
        .stream(text)
        .catch((reason) => {
          trace('error\n')
          resolve({
            success: false,
            reason,
          })
        })
        .then(() => {
          resolve({
            success: true,
            value: text,
          })
        })
    })
  }

  decode(buffer) {
    return this.#decoder.decode(buffer)
  }

  /**
   * Move the focus point of the robot.
   * When the robot looks somewhere, it moves its gaze or face direction
   * toward that point.
   * The function lookAt completes synchronously,
   * and the function does not know when to start or finish moving the gaze.
   *
   * @param position - the position of the point to look at
   */
  lookAt(position: Vector3) {
    this.#gazePoint = position
  }

  /**
   * Show balloon decorator
   *
   * @param text - the text on the balloon
   */
  showBalloon(
    text: string,
    option = {
      right: 20,
      top: 10,
      width: 80,
    }
  ) {
    if (this.#balloon != null) {
      this.hideBalloon()
    }
    if (this.#font == null) {
      this.#font = parseBMF(new Resource(DEFAULT_FONT))
    }
    this.#balloon = createBalloonDecorator({
      ...option,
      height: this.#font.height,
      font: this.#font,
      text,
    })
    this.#renderer.addDecorator(this.#balloon)
  }

  /**
   * Hide balloon decorator
   */
  hideBalloon() {
    if (this.#balloon != null) {
      this.renderer.removeDecorator(this.#balloon)
      this.#balloon = null
    }
  }

  /**
   * Unregister the focus point.
   */
  lookAway() {
    this.#gazePoint = null
  }

  /**
   * Set the pose.
   *
   * @returns void when the robot start moving
   * @experimental
   */
  async setPose(pose: Pose, options?: MotionOptions): Promise<void> {
    return this.#driver.applyRotation(pose.rotation, options)
  }

  /**
   * Set the actuator torque.
   *
   * @returns void when the robot completes setting the torque
   */
  async setTorque(torque: boolean): Promise<void> {
    return this.#driver.setTorque(torque)
  }

  /**
   * Set the color
   * @param{key} - 'primary' or 'secondary'
   * @param{r} - red value [0-255]
   * @param{g} - green value [0-255]
   * @param{b} - blue value [0-255]
   */
  setColor(key: keyof FaceContext['theme'], r, g, b): void {
    this.#faceContext.theme[key] = [r, g, b]
  }

  /**
   * Set the emotion of the robot.
   * The emotion may (or may not) affect the way the robot moves
   * and its facial expressions.
   *
   * @param emotion - emotion
   */
  setEmotion(emotion: Emotion) {
    this.#emotion = emotion
  }

  /**
   * Set the mouth open ratio directly.
   * Used for PC-driven mouth-flap/lip-sync (device TTS drives mouth.open via
   * #power in updateFace() instead; this is for when speech audio plays elsewhere).
   *
   * @param open - open ratio [0-1]
   */
  setMouthOpen(open: number): void {
    this.#faceContext.mouth.open = Math.min(Math.max(open, 0), 1)
  }

  get driver(): Driver {
    return this.#driver
  }

  get tts(): TTS {
    return this.#tts
  }

  get renderer(): Renderer {
    return this.#renderer
  }

  pause() {
    this.#paused = true
  }

  resume() {
    this.#paused = false
    // pause中に経過した時間をtickの飛び越しとして扱わないようにリセットする
    this.#lastFaceUpdateMs = Date.now()
  }
  /**
   * Update the robot face.
   * Process the robot's emotion, pose, gaze point and so on
   * to modify the face context and passes it to Renderer#update
   */
  updateFace() {
    if (this.#paused) {
      return
    }
    // Timer.repeatの呼び出し間隔はシステム負荷で揺れるため、名目上の
    // INTERVAL_FACEではなく実測の経過時間をtickとしてrendererへ渡す。
    // そうしないと呼吸・瞬き・視線移動・ぐるぐる目などtickベースのアニメーションが
    // 実時間とずれて速く見えたり遅く見えたりする。
    const now = Date.now()
    const elapsedMs = Math.min(Math.max(now - this.#lastFaceUpdateMs, 0), INTERVAL_FACE * 4)
    this.#lastFaceUpdateMs = now
    if (this.#power != 0) {
      this.#faceContext.mouth.open = Math.min(
        Math.max(this.#power / 2000, 0),
        1.0
      )
    }
    this.#faceContext.emotion = this.#emotion
    if (this.#gazePoint != null) {
      const relativeGazePoint = Vector3.rotate(this.#gazePoint, {
        r: 0.0,
        y: -this.#pose.body.rotation.y,
        p: -this.#pose.body.rotation.p,
      })
      for (const key of LEFT_RIGHT) {
        const pos = this.#pose.eyes[key].position
        const relative = Vector3.sub(relativeGazePoint, [pos.x, pos.y, pos.z])
        const { y, p } = Rotation.fromVector3(relative)
        const eye = this.#faceContext.eyes[key]
        eye.gazeX = Math.cos(y)
        eye.gazeY = Math.cos(p)
      }
    }
    this.#renderer.update(elapsedMs, this.#faceContext)
  }

  /**
   * Update the robot pose.
   * Get the current pose from the Driver
   * and trigger move if necessary to see the gaze point.
   */
  async updatePose(id) {
    if (this.updating || this.#paused) {
      return
    }
    this.updating = true
    const result = await this.#driver.getRotation()
    if (result.success) {
      this.#pose.body.rotation = result.value
    }

    if (!this.#isMoving && this.#gazePoint != null) {
      const relativeGazePoint = Vector3.rotate(this.#gazePoint, {
        r: 0.0,
        y: -this.#pose.body.rotation.y,
        p: -this.#pose.body.rotation.p,
      })
      const { y, p } = Rotation.fromVector3(relativeGazePoint)
      if (y > Math.PI / 6 || y < -Math.PI / 6 || p > Math.PI / 6 || p < -Math.PI / 6) {
        this.#isMoving = true
        const time = randomBetween(0.5, 1.0)
        await this.#driver.setTorque(true)
        await this.#driver.applyRotation(Rotation.fromVector3(this.#gazePoint))
        Timer.set(async () => {
          await this.#driver.setTorque(false)
          this.#isMoving = false
        }, time * 1000 + 50)
      }
    }
    this.updating = false
  }
}
