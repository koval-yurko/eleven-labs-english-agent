import ActivityKit
import SwiftUI
import WidgetKit

@main
struct ControlsBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOS 16.2, *) {
      LessonActivityWidget()
    }
  }
}

/// The Live Activity registration.
///
/// The Dynamic Island presentations are not optional — `ActivityConfiguration` requires all three
/// (`compact` split in two, `minimal`, `expanded`) — so this is four layouts, not one.
@available(iOS 16.2, *)
struct LessonActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LessonActivityAttributes.self) { context in
      LessonActivityView(context: context)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: icon(for: context.state.phase))
            .foregroundStyle(tint(for: context.state.phase))
        }
        DynamicIslandExpandedRegion(.trailing) {
          // The elapsed timer lives here rather than on the lock screen, which is where the
          // layout budget said the header had to go. Nothing is lost — this is a better home
          // for it anyway. §5.4.
          if context.state.phase != .over {
            Text(context.attributes.title)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 8) {
            WordGrid(
              words: Array(context.state.words.prefix(4)),
              overflow: context.state.overflow + max(0, context.state.words.count - 4),
              focusIndex: context.state.focusIndex
            )
            ControlRow(context: context)
          }
        }
      } compactLeading: {
        Image(systemName: icon(for: context.state.phase))
          .foregroundStyle(tint(for: context.state.phase))
      } compactTrailing: {
        Text("\(context.state.words.count + context.state.overflow)")
          .font(.caption2)
          .foregroundStyle(.secondary)
      } minimal: {
        Image(systemName: icon(for: context.state.phase))
          .foregroundStyle(tint(for: context.state.phase))
      }
    }
  }

  private func icon(for phase: LessonActivityAttributes.Phase) -> String {
    switch phase {
    case .live: return "waveform"
    case .muted: return "mic.slash.fill"
    case .held: return "pause.fill"
    case .over: return "checkmark.circle"
    }
  }

  private func tint(for phase: LessonActivityAttributes.Phase) -> Color {
    switch phase {
    case .live: return .green
    case .muted: return .orange
    case .held: return .secondary
    case .over: return .secondary
    }
  }
}
