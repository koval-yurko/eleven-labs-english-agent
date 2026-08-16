import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { TextField } from "./TextField";
import { radius, space, type } from "./tokens";

/**
 * A text field that offers matches as you type.
 *
 * There is no dropdown primitive in this kit and no Base UI on this side of the workspace, so this
 * is built from parts: a `TextField`, and a list under it wearing the `.select-popup` look (panel
 * fill, hairline border, 10px radius, 6px rows). Its one caller today is the add-word field on
 * `/lesson-items` — see docs/2026-08-15-word-autocomplete-suggestions.md §7.
 *
 * ── Two deliberate departures from that document's plan ─────────────────────────────────────
 *
 * **The list is IN FLOW, not absolutely positioned.** §7 called for a positioned `View` over the
 * page. An absolute overlay in React Native means fighting three things at once — Android clips
 * children that escape their parent's bounds, `zIndex` needs a matching `elevation` there, and the
 * popup would land over the filter panel that follows. In flow, the panel simply grows downward:
 * the field itself does not move, which is the only position the learner is looking at, and the
 * whole class of clipping and stacking bugs cannot happen. The cost is that content below shifts,
 * which is invisible under the keyboard anyway.
 *
 * **It does not use a `FlatList`.** §7 assumed one. Eight rows do not need virtualisation, and a
 * `FlatList` inside the screen's `ScrollView` is the classic RN gesture conflict; a plain
 * `ScrollView` capped by `maxHeight` has the same behaviour with none of it.
 *
 * ── What it owns, so a caller cannot get it wrong ────────────────────────────────────────────
 *
 * The debounce, the stale-response guard, the minimum query length, and the rule that selecting a
 * row fills the field and does NOT submit. Those are the parts that are easy to leave out and
 * invisible when you do.
 */
export interface AutocompleteOption {
  /** Stable identity — the React key, and what `onSelect` hands back. */
  key: string;
  /** The primary text. Selecting the row puts exactly this in the field. */
  label: string;
  /** A small pill at the right of the label — the CEFR level. `null` renders nothing. */
  badge?: string | null;
  /** The second line: the Russian glosses. Load-bearing, see the docblock on `Autocomplete`. */
  detail?: string;
  /** Renders the "you already have this" treatment and appends `markedLabel` to the row's name. */
  marked?: boolean;
}

export function Autocomplete({
  value,
  onChangeText,
  search,
  onSelect,
  markedLabel,
  emptyLabel,
  minChars = 2,
  debounceMs = 150,
  maxHeight = 260,
  style,
  ...field
}: Omit<TextInputProps, "value" | "onChangeText" | "style"> & {
  value: string;
  onChangeText: (next: string) => void;
  /** Resolve matches for a query. Called at most once per `debounceMs`, never below `minChars`. */
  search: (query: string) => Promise<AutocompleteOption[]>;
  /** Fill the field. Deliberately NOT a submit — see the note on `choose` below. */
  onSelect?: (option: AutocompleteOption) => void;
  /** Suffix for a `marked` row's accessible name, e.g. "already in your collection". */
  markedLabel?: string;
  /** Shown when a long-enough query matched nothing. Omit to render nothing at all. */
  emptyLabel?: string;
  minChars?: number;
  debounceMs?: number;
  maxHeight?: number;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  /**
   * The results AND the query they belong to, as one value.
   *
   * Two states rather than one would need clearing whenever the query changes, which means
   * `setState` inside the effect on every keystroke — cascading renders, and the reason the React
   * Compiler rejects it. Pairing them makes staleness a *comparison* instead: results render only
   * while `result.query` still matches what is in the field, so a shortened or edited query hides
   * the old rows without anything having to erase them.
   */
  const [result, setResult] = useState<{ query: string; options: AutocompleteOption[] } | null>(
    null,
  );
  const [open, setOpen] = useState(false);

  /**
   * The stale-response guard. Every query takes a ticket; a reply holding anything but the newest
   * one is dropped. Without it a slow answer for "ubi" can land after a fast answer for "ubiqui"
   * and repopulate the list with the wrong words — the classic typeahead race, and more visible on
   * a phone where the network is slower and less even.
   */
  const seq = useRef(0);

  /**
   * The value a selection just wrote. Without it, filling the field re-triggers the search, which
   * matches the word exactly and reopens the list showing the row that was just chosen.
   *
   * CONSUMED on the next effect run rather than compared forever: held indefinitely, it would also
   * swallow the search when the learner later clears the field and types that same word again.
   */
  const suppressed = useRef<string | null>(null);

  /** Whether the field has focus, read inside async callbacks — see the `.then` below. */
  const focused = useRef(false);

  const query = value.trim();
  const tooShort = query.length < minChars;

  useEffect(() => {
    if (suppressed.current !== null) {
      const justFilled = suppressed.current;
      suppressed.current = null;
      if (value === justFilled) return; // this run IS the fill; anything after it is real typing
    }

    // Bump the ticket and stop. Nothing is cleared, because nothing needs to be: a reply for the
    // old query can no longer win, and `result.query` no longer matches so the old rows are
    // already not rendering.
    if (tooShort) {
      seq.current++;
      return;
    }

    const ticket = ++seq.current;
    const timer = setTimeout(() => {
      void search(query)
        .then((next) => {
          if (seq.current !== ticket) return;
          setResult({ query, options: next });
          // Only if the learner is still in the field. A reply can outlive the focus — type, tap
          // away, and an unguarded `setOpen(true)` pops a dropdown open under a dismissed keyboard.
          if (focused.current) setOpen(true);
        })
        .catch(() => {
          if (seq.current !== ticket) return;
          // Silent, and `null` rather than an empty list: this fires on every flaky keystroke, and
          // the field still works without suggestions. An empty list would claim "no matches",
          // which is a different and wrong statement.
          setResult(null);
        });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [value, query, tooShort, debounceMs, search]);

  /**
   * Fill the field; never submit.
   *
   * A dropdown that submits on tap makes a mis-tap unrecoverable, and on a phone mis-taps are the
   * common case. It also keeps the write path byte-identical — the server never learns whether the
   * learner picked a row or typed the word out. Decision D4 in the design doc.
   */
  function choose(option: AutocompleteOption) {
    suppressed.current = option.label;
    setOpen(false);
    setResult(null);
    onChangeText(option.label);
    onSelect?.(option);
  }

  // Fresh == the results describe what is in the field right now. Anything else is not shown.
  const fresh = !tooShort && result?.query === query ? result.options : null;
  const showList = open && fresh !== null && fresh.length > 0;
  const showEmpty = open && fresh !== null && fresh.length === 0 && Boolean(emptyLabel);

  return (
    <View style={style}>
      <TextField
        {...field}
        value={value}
        onChangeText={onChangeText}
        // iOS rewrites a deliberately-typed word on its way out of the field — which is precisely
        // the failure this control exists to prevent. Forced rather than defaulted: a caller that
        // forgets would make the problem worse, not better.
        autoCorrect={false}
        autoCapitalize="none"
        // The field is a combobox now, and the list's presence is the part a screen reader needs.
        accessibilityState={{ expanded: showList }}
        onBlur={(e) => {
          focused.current = false;
          // Safe because every ScrollView above this one sets `keyboardShouldPersistTaps="handled"`
          // (see `Screen`): a tap on a row is delivered to the row instead of being spent
          // dismissing the keyboard, so blur does not fire before the press. Without that prop the
          // learner would have to tap twice and the control would read as broken — §7.1, hazard 1.
          setOpen(false);
          field.onBlur?.(e);
        }}
        onFocus={(e) => {
          focused.current = true;
          if (fresh !== null && fresh.length > 0) setOpen(true);
          field.onFocus?.(e);
        }}
      />

      {showList && fresh ? (
        <View style={styles.popup}>
          <ScrollView
            style={{ maxHeight }}
            keyboardShouldPersistTaps="handled"
            // Android only; iOS nests scroll views natively. Eight rows rarely need it, which is
            // why the server caps at eight.
            nestedScrollEnabled
          >
            {fresh.map((option) => (
              <Pressable
                key={option.key}
                onPress={() => choose(option)}
                accessibilityRole="menuitem"
                // One string, not three fragments: a reader that announces "ubiquitous", "C1",
                // "вездесущий" as separate nodes makes the learner swipe through a table.
                accessibilityLabel={[
                  option.label,
                  option.badge ? `level ${option.badge}` : null,
                  option.detail,
                  option.marked ? markedLabel : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                style={({ pressed }) => [styles.row, pressed ? styles.rowDown : null]}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.label} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {option.badge ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{option.badge}</Text>
                    </View>
                  ) : null}
                </View>
                {option.detail ? (
                  // Two lines, not one. This is the column that answers "did I spell the word I
                  // meant", and it is also what makes a surprising level legible — `arms [C2]`
                  // reads as a bug beside `arm [A1]` until the gloss says `герб`. Truncate it;
                  // never drop it for width.
                  <Text style={styles.detail} numberOfLines={2}>
                    {option.detail}
                  </Text>
                ) : null}
                {option.marked && markedLabel ? (
                  <Text style={styles.marked}>{markedLabel}</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
          {/* Announced, not drawn — the count is obvious to anyone who can see the list. */}
          <View
            accessibilityLiveRegion="polite"
            accessibilityLabel={`${fresh.length} suggestions`}
          />
        </View>
      ) : null}

      {showEmpty ? <Text style={styles.empty}>{emptyLabel}</Text> : null}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    /** `.select-popup`, in flow rather than anchored — see the docblock. */
    popup: {
      marginTop: 4,
      backgroundColor: t.panel,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.popup,
      padding: 4,
      overflow: "hidden",
    },
    row: {
      paddingVertical: 0.45 * 16,
      paddingHorizontal: 0.6 * 16,
      borderRadius: radius.item,
      gap: 2,
    },
    rowDown: { backgroundColor: t.sunken },
    rowTop: { flexDirection: "row", alignItems: "center", gap: space.row },
    label: { ...type.body, color: t.text, flexShrink: 1, minWidth: 0 },
    /** The `.chip` pill, shrunk — a label here, never a control. */
    badge: {
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.pill,
      paddingHorizontal: 0.5 * 16,
      paddingVertical: 1,
    },
    badgeText: { ...type.tiny, color: t.muted, fontWeight: type.weightMedium },
    detail: { ...type.small, color: t.muted },
    marked: { ...type.tiny, color: t.accent },
    empty: { ...type.small, color: t.faint, marginTop: space.row },
  });
