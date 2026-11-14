/**
 * ABOUTME: The most bytes DevTune takes for each uploaded artifact: the bundle writer trims to them, the uploader checks
 * them, and the server's selfRunArtifactByteLimit reads them from here.
 */
import { SOURCE_ARTIFACT_BYTES } from '../assets/capture-sources';

/** diff.patch and source-files.json have their own limits; every other artifact takes at most 50 MiB. */
export const UPLOAD_ARTIFACT_BYTE_LIMITS = {
  'diff.patch': 800_000,
  'source-files.json': 2 * SOURCE_ARTIFACT_BYTES,
  other: 50 * 1024 * 1024,
} as const;

/** The upload limit for one captured artifact. */
export function uploadArtifactByteLimit(name: string): number {
  return name === 'diff.patch' || name === 'source-files.json'
    ? UPLOAD_ARTIFACT_BYTE_LIMITS[name]
    : UPLOAD_ARTIFACT_BYTE_LIMITS.other;
}
