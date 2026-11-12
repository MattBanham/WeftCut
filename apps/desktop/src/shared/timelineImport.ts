export type TimelineCompatibilityStatus = 'exact' | 'converted' | 'approximated' | 'unsupported'
export interface TimelineCompatibilityItem {
  location: string
  label: string
  lane: number
  status: TimelineCompatibilityStatus
  notes: string[]
}

export interface TimelineImportReport {
  name: string
  destination: string | null
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
  rateConformedVideoClips: number
  resizedVideoClips: number
  videoConversions: {
    source: string
    sourceWidth: number
    sourceHeight: number
    sourceFps: { num: number; den: number }
    pixelAspect: { h: number; v: number } | null
    spatialConform: 'fit' | 'fill' | 'none'
    rateConformed: boolean
    scaledToFit: boolean
  }[]
  normalizedTimecode: boolean
  dropFrameTimecode: boolean
  namedFormatDefaults: boolean
  bundleSource: boolean
  relinkedMedia: { from: string; to: string }[]
  compatibilityItems: TimelineCompatibilityItem[]
  compatibilityCounts: { exact: number; converted: number; approximated: number; unsupported: number }
}

export interface TimelineImportPreview extends TimelineImportReport {
  id: string
  current: { width: number; height: number; fps: { num: number; den: number }; sampleRate: number; channels: number } | null
}

export interface TimelineProjectDestination {
  parentFolder: string
  name: string
}

export interface TimelineSequenceChoice {
  index: number
  name: string
  event: string | null
  location: string
}
