require 'fileutils'

# ── The shared Swift ─────────────────────────────────────────────────────────────────────────
# `LessonActivityAttributes` and the intent types must be compiled into BOTH binaries: the widget
# extension renders the card and references the intents, while the app runs `Activity.request` and
# executes `perform()` — a `LiveActivityIntent` runs in the containing app's process, not the
# extension's. One definition, two targets.
#
# Xcode expresses that with shared target membership. Neither build system here can:
#
#   * @bacons/apple-targets compiles `targets/controls/` as a synchronized folder reference and
#     offers no way to add sources from anywhere else;
#   * CocoaPods resolves `source_files` against the pod root and SILENTLY DROPS anything outside it.
#     A "../../../targets/controls/*.swift" pattern matches nothing, warns about nothing, and
#     produces exactly one symptom — "cannot find type 'LessonActivityAttributes' in scope" — minutes
#     into an EAS build, from the app target only.
#
# So the files are mirrored into the pod root here, at `pod install` time, from the single copy in
# `targets/controls/`. `shared/` is generated and gitignored: never edit it, edit the original.
#
# Gitignoring the mirror is deliberate rather than tidiness. A fresh checkout — which is every EAS
# build — has no `shared/` at all, so if `pod install` is ever skipped or cached away, the build
# fails on missing files instead of quietly compiling a stale copy of a contract that has since
# changed. Loud beats silent for a file whose whole job is to agree with another binary.
# See docs/2026-08-16-background-controls-lock-screen.md §4.4.
pod_root = File.dirname(__FILE__)
shared_source_dir = File.expand_path(File.join(pod_root, '..', '..', '..', 'targets', 'controls'))
shared_mirror_dir = File.join(pod_root, 'shared')
shared_file_names = ['LessonActivityAttributes.swift', 'ControlIntents.swift']

FileUtils.mkdir_p(shared_mirror_dir)
shared_file_names.each do |name|
  source = File.join(shared_source_dir, name)
  unless File.exist?(source)
    raise "[LessonActivity] Missing shared source #{source}. It is compiled into both the app and " \
          "the controls extension; see docs/2026-08-16-background-controls-lock-screen.md 4.4."
  end
  FileUtils.cp(source, File.join(shared_mirror_dir, name))
end
# A file deleted from `targets/controls/` must not survive here as a stale copy that still compiles.
Dir.glob(File.join(shared_mirror_dir, '*.swift')).each do |existing|
  FileUtils.rm(existing) unless shared_file_names.include?(File.basename(existing))
end

Pod::Spec.new do |s|
  s.name           = 'LessonActivity'
  s.version        = '1.0.0'
  s.summary        = 'Lock-screen Live Activity controls for a tutor session'
  s.description    = 'Starts, updates and ends the lesson Live Activity, and forwards its taps to JS.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The app target compiles the shared files too, so it needs what they import. Swift autolinks
  # these from `import`, but naming them is free and removes a class of link failure that would
  # otherwise only ever appear on EAS.
  # WidgetKit is for `ControlCenter.shared.reloadControls(ofKind:)` — the app has to tell the
  # Control Center to redraw when the lesson phase changes, because a control's state is pulled
  # rather than pushed. See docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md 1.6.
  # MediaPlayer is the Now Playing surface — MPNowPlayingInfoCenter and MPRemoteCommandCenter.
  s.frameworks = 'ActivityKit', 'AppIntents', 'WidgetKit', 'MediaPlayer'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '*.{h,m,swift}', 'shared/*.swift'
end
