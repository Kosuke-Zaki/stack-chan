export interface MemoryStatus {
  psramInitialized: boolean
  psramTotal: number
  psramFree: number
  psramMinimum: number
  psramLargest: number
  internalFree: number
  internalMinimum: number
  dmaFree: number
}

export default function getMemoryStatus(): MemoryStatus