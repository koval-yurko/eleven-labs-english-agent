import { useMemo, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { Button } from "./Button";
import { Muted } from "./Text";
import { TextField } from "./TextField";
import { overlay, radius, space, type } from "./tokens";

/**
 * `ConfirmDialog` with one text field — for an action that needs a word from the learner before it
 * runs, rather than only a yes.
 *
 * It exists because of the selection bar. That bar is pinned to the bottom of the viewport, above
 * a keyboard, and it must stay one row tall; the lesson-title field that used to sit inside it is
 * the one control that cannot honour either constraint. Moved here, the keyboard opens over a
 * dialog — which is the surface that expects one — instead of over the list the learner is still
 * choosing from. See docs/2026-08-18-collection-and-lessons-list-fixes.md §3.3.
 *
 * Everything else is `ConfirmDialog`'s behaviour, kept deliberately rather than re-decided: the
 * scrim does not dismiss, the back gesture does, Cancel comes first and reads as the quiet option,
 * and the popup itself scrolls so a long prompt can never push the buttons out of reach.
 *
 * **The value is uncontrolled from the caller's side**, and `initialValue` is applied on each OPEN.
 * That is the whole point of a prompt: the caller computes a default (today's date, the current
 * name) at the moment it asks, and does not want a stale draft from the last time the dialog was
 * dismissed. `onSubmit` hands the value back; the caller never holds it between openings.
 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  initialValue = "",
  maxLength,
  submitLabel,
  cancelLabel = "Cancel",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** The field's accessibility label. Not rendered — `title` and `description` carry the prose. */
  label: string;
  placeholder?: string;
  /** Applied every time the dialog opens, so the caller's default is never stale. */
  initialValue?: string;
  maxLength?: number;
  submitLabel: string;
  cancelLabel?: string;
  /** Receives the raw field value — trimming and defaulting stay the caller's rules, not ours. */
  onSubmit: (value: string) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [value, setValue] = useState(initialValue);

  /**
   * Reset the field on each OPEN — React's documented "adjust state when a prop changes" pattern,
   * not an effect.
   *
   * An effect would render the previous draft once and blank it on the next commit, which is a
   * visible flash of last time's text; setting during render re-renders before anything is shown.
   * `react-hooks/set-state-in-effect` rejects the effect version, and is right to.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initialValue);
  }

  function submit() {
    // Close first, for the same reason `ConfirmDialog` does: the handler may navigate, and a modal
    // still mounted over a route change strands the screen behind a scrim.
    onOpenChange(false);
    onSubmit(value);
  }

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => onOpenChange(false)}
    >
      <View style={styles.scrim}>
        <ScrollView contentContainerStyle={styles.viewport} keyboardShouldPersistTaps="handled">
          <View
            style={styles.popup}
            accessibilityViewIsModal
            accessibilityLabel={title}
          >
            <Text style={styles.title}>{title}</Text>
            {description ? <Muted style={styles.description}>{description}</Muted> : null}
            <TextField
              value={value}
              onChangeText={setValue}
              placeholder={placeholder}
              maxLength={maxLength}
              accessibilityLabel={label}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submit}
              style={styles.field}
            />
            <View style={styles.actions}>
              <Button variant="secondary" label={cancelLabel} onPress={() => onOpenChange(false)} />
              <Button variant="primary" label={submitLabel} onPress={submit} />
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: overlay.scrim },
    viewport: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 16 },
    popup: {
      width: "100%",
      maxWidth: overlay.dialogWidth,
      backgroundColor: t.panel,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.panel,
      padding: space.panelPadding,
    },
    title: {
      fontSize: 1.1 * 16,
      lineHeight: 1.1 * 16 * 1.4,
      fontWeight: type.weightBold,
      color: t.text,
    },
    description: { marginTop: space.row },
    field: { marginTop: space.panelGap },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "flex-end",
      gap: space.row,
      marginTop: space.panelPadding,
    },
  });
