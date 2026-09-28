import type { DeviceProfile } from "@jellyfin/sdk/lib/generated-client/models";

/** Browser playback must never inherit the native FFmpeg decoder's capabilities.
 * MKV is remuxed into HLS; compatible H.264 can be copied while unsupported audio
 * is converted to AAC. No surround codec is advertised without a real decoder.
 */
export const browserProfile = {
  Name: "StingStream browser",
  MaxStreamingBitrate: 999_999_999,
  MaxStaticBitrate: 999_999_999,
  DirectPlayProfiles: [
    {
      Type: "Video",
      Container: "mp4,m4v",
      VideoCodec: "h264",
      AudioCodec: "aac,mp3",
    },
    {
      Type: "Video",
      Container: "webm",
      VideoCodec: "vp8,vp9",
      AudioCodec: "opus,vorbis",
    },
    { Type: "Audio", Container: "mp3", AudioCodec: "mp3" },
    { Type: "Audio", Container: "m4a,aac", AudioCodec: "aac" },
    { Type: "Audio", Container: "flac", AudioCodec: "flac" },
  ],
  TranscodingProfiles: [
    {
      Type: "Video",
      Container: "ts",
      Protocol: "hls",
      Context: "Streaming",
      VideoCodec: "h264",
      AudioCodec: "aac",
      MaxAudioChannels: "2",
      MinSegments: 2,
      BreakOnNonKeyFrames: true,
    },
    {
      Type: "Audio",
      Container: "mp3",
      Protocol: "http",
      Context: "Streaming",
      AudioCodec: "mp3",
      MaxAudioChannels: "2",
    },
  ],
  CodecProfiles: [
    {
      Type: "Video",
      Codec: "h264",
      Conditions: [
        {
          Condition: "LessThanEqual",
          Property: "VideoBitDepth",
          Value: "8",
          IsRequired: false,
        },
        {
          Condition: "LessThanEqual",
          Property: "VideoLevel",
          Value: "52",
          IsRequired: false,
        },
      ],
    },
    {
      Type: "VideoAudio",
      Codec: "aac,mp3,opus,vorbis",
      Conditions: [
        {
          Condition: "LessThanEqual",
          Property: "AudioChannels",
          Value: "2",
          IsRequired: true,
        },
      ],
    },
  ],
  SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
} satisfies DeviceProfile;
