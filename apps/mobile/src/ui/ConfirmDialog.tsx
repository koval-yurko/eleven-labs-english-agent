import { useMemo } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { Button } from "./Button";
import { Muted } from "./Text";
import { overlay, radius, space, type } from "./tokens";

/**
 * A yes/no confirmation for an action that can't be undone — the web's `ConfirmDialog`.
 *
 * This replaces `Alert.alert`. The native alert is the better-behaved iOS citizen and it is one
 * line of code; what it cannot be is *this app's* dialog. It is drawn by the system, in the system's
 * type and the system's colours, and it ignores the theme entirely — the same class of problem as
 * the OS-drawn `<select>` the web replaced.
 *
 * Two behaviours carried over rather than reinvented:
 *
 *  - **The scrim does not dismiss.** A destructive action should need an actual answer, not a stray
 *    tap. `onRequestClose` (the Android back gesture) still backs out, as Escape does on the web.
 *  - **Cancel comes first and reads as the quiet option**, so the destructive button isn't the only
 *    thing the eye lands on and the recovery action isn't the harder one to hit.
 *
 * Controlled, so one dialog serves a whole list driven by "which row is pending" rather than one
 * mounted per row.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => onOpenChange(false)}
    >
      {/* `.dialog-viewport` — centres the popup and, on a short screen, is the thing that scrolls,
          so a long prompt can never push the buttons off the bottom where they can't be reached. */}
      <View style={styles.scrim}>
        <ScrollView
          contentContainerStyle={styles.viewport}
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={styles.popup}
            accessibilityViewIsModal
            accessibilityRole="alert"
            accessibilityLabel={title}
          >
            <Text style={styles.title}>{title}</Text>
            {description ? <Muted style={styles.description}>{description}</Muted> : null}
            <View style={styles.actions}>
              <Button
                variant="secondary"
                label={cancelLabel}
                onPress={() => onOpenChange(false)}
              />
              <Button
                variant="primary"
                tone="danger"
                label={confirmLabel}
                onPress={() => {
                  // Close first: the caller's handler may navigate, and a modal still mounted over
                  // a route change is the classic way to strand a screen behind a scrim.
                  onOpenChange(false);
                  onConfirm();
                }}
              />
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
    viewport: {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    popup: {
      width: "100%",
      maxWidth: overlay.dialogWidth,
      backgroundColor: t.panel,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.panel,
      padding: space.panelPadding,
    },
    /** `.dialog-title { font-size: 1.1rem; font-weight: 700 }` — smaller than an `H2`. */
    title: { fontSize: 1.1 * 16, lineHeight: 1.1 * 16 * 1.4, fontWeight: type.weightBold, color: t.text },
    description: { marginTop: space.row },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "flex-end",
      gap: space.row,
      marginTop: space.panelPadding,
    },
  });
