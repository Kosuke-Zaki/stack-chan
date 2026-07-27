import { RendererBase, Layer, type FacePartFactory, type FaceContext } from 'renderer-base'
import { createBlinkModifier, createBreathModifier, createSaccadeModifier } from 'modifier'

/**
 * ぐるぐる目（DIZZY）用の渦巻き座標を1回だけ計算しておく（毎フレームtrig計算しない）。
 * 対話中(TTS)と同時に動かすと処理落ちしたため、常時回転させず固定形状にしている。
 */
function buildSpiralOffsets(radius: number, turns = 1.5, steps = 8): { x: number; y: number }[] {
  const offsets = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * turns * 2 * Math.PI
    const r = (i / steps) * radius
    offsets.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
  }
  return offsets
}

// Renderers
export const createEyelidPart: FacePartFactory<{
  cx: number
  cy: number
  width: number
  height: number
  side: keyof FaceContext['eyes']
}> =
  ({ cx, cy, width, height, side }) =>
  (_tick, path, { eyes, emotion }) => {
    const eye = eyes[side]
    const w = width
    const h = height * (1 - eye.open)
    const x = cx - width / 2
    const y = cy - height / 2
    let h1
    let h2
    switch (emotion) {
      case 'ANGRY':
      case 'SAD':
        h1 = y + (height + h) / 2
        h2 = y + h
        if (side === 'left') {
          ;[h1, h2] = [h2, h1]
        }
        if (emotion === 'SAD') {
          ;[h1, h2] = [h2, h1]
        }
        path.moveTo(x, y)
        path.lineTo(x, h1)
        path.lineTo(x + w, h2)
        path.lineTo(x + w, y)
        path.closePath()
        break
      case 'SLEEPY':
        path.rect(x, y, w, height * 0.5 + h * 0.5)
        break
      case 'HAPPY':
        path.rect(x, y, w, h * 0.6)
        path.rect(x, y + height * 0.6, w, height * 0.4)
        break
      case 'DOUBTFUL':
        // 片目だけ疑わしそうに細める（leftのみ大きく閉じる）
        path.rect(x, y, w, side === 'left' ? height * 0.6 + h * 0.4 : h)
        break
      case 'COLD':
        // 寒さでぎゅっと目を細める
        path.rect(x, y, w, height * 0.75 + h * 0.25)
        break
      case 'HOT':
        // 暑さでうんざりした半目
        path.rect(x, y, w, height * 0.45 + h * 0.55)
        break
      default:
        path.rect(x, y, w, h)
    }
  }

export const createEyePart: FacePartFactory<{
  cx: number
  cy: number
  radius?: number
  side: keyof FaceContext['eyes']
}> = ({ cx, cy, radius = 8, side }) => {
  const spiralOffsets = buildSpiralOffsets(radius)
  return (_tick, path, { eyes, emotion }) => {
    const eye = eyes[side]
    const offsetX = (eye.gazeX ?? 0) * 2
    const offsetY = (eye.gazeY ?? 0) * 2
    if (emotion === 'DIZZY') {
      // 固定の渦巻き形を描くだけ（回転させない。処理負荷を抑えるため）
      const baseX = cx + offsetX
      const baseY = cy + offsetY
      spiralOffsets.forEach(({ x, y }, i) => {
        if (i === 0) {
          path.moveTo(baseX + x, baseY + y)
        } else {
          path.lineTo(baseX + x, baseY + y)
        }
      })
      return
    }
    const r = emotion === 'SURPRISED' ? radius * 1.6 : radius
    path.arc(cx + offsetX, cy + offsetY, r, 0, 2 * Math.PI)
  }
}

export const createMouthPart: FacePartFactory<{
  cx: number
  cy: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
}> =
  ({ cx, cy, minWidth = 50, maxWidth = 90, minHeight = 8, maxHeight = 58 }) =>
  (_tick, path, { mouth }) => {
    const openRatio = mouth.open
    const h = minHeight + (maxHeight - minHeight) * openRatio
    const w = minWidth + (maxWidth - minWidth) * (1 - openRatio)
    const x = cx - w / 2
    const y = cy - h / 2
    path.rect(x, y, w, h)
  }

export class Renderer extends RendererBase {
  constructor(option) {
    super(option)
    this.filters = [
      createBlinkModifier({ openMin: 400, openMax: 5000, closeMin: 200, closeMax: 400 }),
      createBreathModifier({ duration: 6000 }),
      createSaccadeModifier({ updateMin: 300, updateMax: 2000, gain: 0.2 }),
    ]
    const layer1 = new Layer({ colorName: 'primary' })
    this.layers.push(layer1)
    layer1.addPart(
      'leftEye',
      createEyePart({
        cx: 90,
        cy: 93,
        side: 'left',
        radius: 8,
      })
    )
    layer1.addPart('rightEye', createEyePart({ cx: 230, cy: 96, side: 'right', radius: 8 }))
    layer1.addPart('mouth', createMouthPart({ cx: 160, cy: 148 }))

    const layer2 = new Layer({ colorName: 'secondary' })
    this.layers.push(layer2)
    layer2.addPart(
      'leftEyelid',
      createEyelidPart({
        cx: 90,
        cy: 93,
        side: 'left',
        width: 24,
        height: 24,
      })
    )
    layer2.addPart(
      'rightEyelid',
      createEyelidPart({
        cx: 230,
        cy: 96,
        side: 'right',
        width: 24,
        height: 24,
      })
    )
  }
}
