// SPIKE ONLY — path A of docs/2026-08-27-vapi-third-voice-provider.md. NEVER MERGE.
//
// The app has no metro.config.js on any other branch, and should not gain one from this work. It
// exists here for exactly one reason: to make `@daily-co/react-native-webrtc` resolve to
// `@livekit/react-native-webrtc`.
//
// ## Why this is the fix, and why pinning a version is not
//
// The error is `frameworks with conflicting names: webrtc.xcframework`. That is CocoaPods refusing
// to link two vendored frameworks that share a NAME — it is not a version comparison, and no pair
// of versions makes it go away:
//
//   LiveKit  livekit-react-native-webrtc → pod WebRTC-SDK   → WebRTC.xcframework
//   Daily    react-native-webrtc         → pod JitsiWebRTC  → WebRTC.xcframework
//
// Two pods, two frameworks, one name. Aligning M118 and M137 would still leave two of them. (It is
// also not available: Daily's fork stops at 124.0.6-daily.2 and LiveKit's starts at 125.0.12 —
// the published ranges do not overlap at all.)
//
// So the only fix is to have ONE webrtc package on disk. Three findings say that is possible:
//
//   1. `react-native-daily-js`'s podspec depends on `React-Core` and its own screen-share
//      extension — NOT on the webrtc pod. Daily's native layer does not drag Jitsi in; only the
//      JS peer dependency does.
//   2. Every JS module in Daily's fork exists in LiveKit's (36 files vs 45; the extra 9 are
//      LiveKit additions — RTCAudioSession, the frame cryptors, RTCPIPView). Nothing Daily ships
//      is missing from LiveKit.
//   3. The one API difference worth checking — `mediaDevices.ondevicechange` / the `devicechange`
//      event, which Daily's index re-exports — is present in LiveKit's `MediaDevices.ts`, which
//      extends EventTarget and defines both the attribute and the event.
//
// So `@daily-co/react-native-webrtc` is uninstalled, and this redirects its imports. One package,
// one podspec, one WebRTC.xcframework, and — the part that matters more than the build — ONE set
// of `WebRTCModule` / `RTCPeerConnection` / `RTCAudioSession` ObjC classes instead of two
// definitions of each from two WebRTC generations (§12.3).
//
// ## What this does NOT make safe
//
// It removes the collision. It does not make Daily's M118-era JS correct against LiveKit's M137
// native code. Anything Daily calls that changed shape between those generations fails HERE, at
// runtime, not at build. That is what /spike-vapi is for.
//
// The tsconfig `paths` entry beside this does the same redirect for the type checker.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const FROM = "@daily-co/react-native-webrtc";
const TO = "@livekit/react-native-webrtc";

const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === FROM || moduleName.startsWith(`${FROM}/`)) {
    const redirected = TO + moduleName.slice(FROM.length);
    return (upstream ?? context.resolveRequest)(context, redirected, platform);
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
