import type { TimelineCompatibilityItem } from '../../../shared/timelineImport'
import type { ExactTime } from '../../../shared/timeMapping'
import type { AudioRole, Rational } from '../model'

import type { OriginalMediaPath } from './mediaPath'

export interface TimelineSource extends OriginalMediaPath {
  ref: string
  hasVideo: boolean
  /** FCPXML's zero-duration asset is a still image displayed for the clip's timeline span. */
  stillImage?: boolean
  sourceColor?: string
  imageSize?: { width: number; height: number }
  videoFormat?: { width: number; height: number; frameDuration: ExactTime; paspH: number; paspV: number }
  hasAudio?: boolean
  audioChannels?: number
  audioRate?: number
}

export interface TimelineClip {
  label?: string
  enabled?: boolean
  hasVideo: boolean
  asset: TimelineSource
  lane: number
  timelineStart: ExactTime
  timelineEnd: ExactTime
  firstFrame: number
  endFrame: number
  sourceIn: ExactTime
  sourceOut: ExactTime
  playbackRate?: ExactTime
  preservePitch?: boolean
  audioRole: AudioRole | null
  conform?: 'fit' | 'fill' | 'none'
  volumeDb?: number
  opacity?: number
  staticTransform?: { xPercent: number; yPercent: number; scaleX: number; scaleY: number; rotation: number }
  markers: { label: string; frame: number; endFrame: number | null; source: ExactTime }[]
  location: string
  notes: string[]
}

export interface ImportTimeline {
  name?: string
  canvas?: { width: number; height: number }
  fps: Rational
  durationFrames: number
  clips: TimelineClip[]
  dissolves?: { from: TimelineClip; to: TimelineClip; firstFrame: number; endFrame: number }[]
  notices: TimelineCompatibilityItem[]
  omittedEffects?: TimelineCompatibilityItem[]
  normalizedTimecode?: boolean
  dropFrameTimecode?: boolean
  namedFormatDefaults?: boolean
  sourceColor?: string
}
