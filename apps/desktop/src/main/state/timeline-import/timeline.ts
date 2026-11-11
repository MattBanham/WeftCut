import type { ExactTime } from '../../../shared/timeMapping'
import type { AudioRole, Rational } from '../model'

export interface TimelineSource {
  ref: string
  path: string
  hasAudio?: boolean
  audioChannels?: number
  audioRate?: number
}

export interface TimelineClip {
  label?: string
  asset: TimelineSource
  firstFrame: number
  endFrame: number
  sourceIn: ExactTime
  sourceOut: ExactTime
  audioRole: AudioRole | null
  markers: { label: string; frame: number; source: ExactTime }[]
  location: string
}

export interface ImportTimeline {
  name?: string
  canvas?: { width: number; height: number }
  fps: Rational
  durationFrames: number
  clips: TimelineClip[]
}
