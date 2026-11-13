export type TimelineCompatibilityStatus = 'exact' | 'converted' | 'approximated' | 'unsupported'
export interface TimelineCompatibilityItem {
  location: string
  label: string
  lane: number
  status: TimelineCompatibilityStatus
  notes: string[]
}

export interface TimelineMediaIssue {
  assetRef: string
  filename: string
  sourcePath: string
  placements: number
  detail: string
}

export interface TimelineMediaChange extends TimelineMediaIssue {
  kind: 'still-size' | 'video-size' | 'video-rate' | 'audio-format' | 'color-format'
}

export interface TimelineMediaBlocked {
  kind: 'media-blocked'
  issues: TimelineMediaIssue[]
  canSearchFolder: boolean
  effectIssues: TimelineCompatibilityItem[]
  mediaChanges: TimelineMediaChange[]
}

export interface TimelineEditBlocked {
  kind: 'edit-blocked'
  issues: TimelineCompatibilityItem[]
  canOmitEffects: boolean
  mediaChanges: TimelineMediaChange[]
}

export type TimelinePreflight = TimelineImportPreview | TimelineMediaBlocked | TimelineEditBlocked

export interface TimelineMediaReplacement {
  assetRef: string
  path: string
}

export interface TimelineImportReport {
  mediaChanges: TimelineMediaChange[]
  outputColorChange: string | null
  omittedEffects: TimelineCompatibilityItem[]
  name: string
  destination: string | null
  width: number
  height: number
  fps: { num: number; den: number }
  durationFrames: number
  compoundGroups: number
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

export interface TimelineSequenceList {
  documentId: string
  choices: TimelineSequenceChoice[]
}

export interface TimelineSequenceChoice {
  index: number
  name: string
  event: string | null
  location: string
}
