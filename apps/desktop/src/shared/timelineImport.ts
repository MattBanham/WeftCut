export interface EdlImportOptions {
  mediaDirectory: string
  fpsNum: number
  fpsDen: number
  recordOrigin: string
  sourceOrigin: string
}

export interface TimelineImportReport {
  name: string
  destination: string
  width: number
  height: number
  fps: { num: number; den: number }
  durationFrames: number
  videoClips: number
  audioClips: number
  markers: number
  media: number
  lanes: number[]
  connectedClips: number
  roundedEnds: number
  resampledAudioClips: number
  downmixedAudioClips: number
  normalizedTimecode: boolean
  dropFrameTimecode: boolean
  namedFormatDefaults: boolean
  bundleSource: boolean
  relinkedMedia: { from: string; to: string }[]
}

export interface TimelineImportPreview extends TimelineImportReport {
  id: string
  mode: 'new' | 'current'
  current?: { width: number; height: number; fps: { num: number; den: number }; sampleRate: number; channels: number }
}
