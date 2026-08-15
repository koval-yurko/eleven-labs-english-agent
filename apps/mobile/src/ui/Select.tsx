import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { control, overlay, radius, type } from "./tokens";

export type SelectOption<T extends string> = { value: T; label: string };

/**
 * `Select` — the trigger + popup pair from `apps/web/src/app/Select.tsx` and the `.select-*` rules.
 *
 * This replaces the SwiftUI `Menu` (sort) and `Picker` (tutor version). Both were better native
 * citizens; neither looks anything like the web's control, which is the point of the port.
 *
 * Two details carried over deliberately from the CSS, because both are load-bearing and neither is
 * obvious:
 *
 *  - **The trigger takes the FIELD palette, not the button's.** It is a field, not an action.
 *  - **`minWidth: 0` on the trigger and on its value text.** Every call site puts the trigger in a
 *    flex row, where the default lets a long label push the control past its container instead of
 *    letting it shrink. Zeroing it is what makes the ellipsis engage — it is the narrow-screen fix,
 *    and phones are all narrow screens.
 *
 * The popup is a `Modal` rather than an anchored positioner. Base UI measures the trigger and
 * publishes `--anchor-width`/`--available-height` so the list opens against it; RN has no
 * equivalent without measuring by hand, and an anchored popup that mis-measures on a phone lands
 * off-screen. A centred sheet is the honest simplification, and the popup's own look — panel fill,
 * hairline border, 10px radius, a tick gutter every row shares — is reproduced exactly.
 */
export function Select<T extends string>({
  value,
  options,
  onValueChange,
  disabled,
  label,
}: {
  value: T;
  options: SelectOption<T>[];
  onValueChange: (next: T) => void;
  disabled?: boolean;
  /** The accessible name. The web takes it from a visible `<span>`; there is no such pairing here. */
  label: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(false);

  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: current?.label }}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={[
          styles.trigger,
          open ? styles.triggerOpen : null,
          disabled ? styles.disabled : null,
        ]}
      >
        {/* numberOfLines + the zeroed min-width are what let a long version label shorten the
            trigger rather than widen it past the panel. */}
        <Text style={styles.value} numberOfLines={1}>
          {current?.label ?? ""}
        </Text>
        <ChevronDownIcon size={16} color={theme.muted} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
        // iOS keeps the status bar's own appearance under a transparent modal; without this the
        // scrim darkens the page but the clock stays styled for the page underneath.
        statusBarTranslucent
      >
        {/* The scrim is also the dismiss target, as `.dialog-backdrop` is on the web. */}
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close">
          {/* Swallows taps so a press inside the popup doesn't dismiss it. */}
          <Pressable style={styles.popup} onPress={() => {}}>
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {options.map((option) => {
                const selected = option.value === value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [styles.item, pressed ? styles.itemDown : null]}
                  >
                    {/* The gutter is reserved on EVERY row, selected or not, so the labels share one
                        left edge — it cannot come from the tick itself, which is unmounted when the
                        row isn't selected. */}
                    <View style={styles.gutter}>
                      {selected ? <CheckIcon size={14} color={theme.accent} /> : null}
                    </View>
                    {/* Wraps rather than truncates: the popup is where the full label has to be
                        readable, which is the whole reason the trigger is allowed to ellipsise. */}
                    <Text style={styles.itemText}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      // A field, not an action — it takes the field palette rather than the button's.
      backgroundColor: t.sunken,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.control,
      paddingVertical: control.paddingVerticalSm,
      paddingHorizontal: control.paddingHorizontalSm,
      minHeight: control.heightSm,
      maxWidth: "100%",
      minWidth: 0, // see the docblock — this is the narrow-screen fix
    },
    triggerOpen: { borderColor: t.accent },
    disabled: { opacity: 0.5 },
    value: { ...type.body, color: t.text, flexShrink: 1, minWidth: 0 },

    scrim: {
      flex: 1,
      backgroundColor: overlay.scrim,
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
      borderRadius: radius.popup,
      padding: 4,
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 0.45 * 16,
      paddingRight: 0.6 * 16,
      borderRadius: radius.item,
    },
    itemDown: { backgroundColor: t.sunken },
    /** `.select-item { padding-left: 1.75rem }` with the tick absolutely placed at `left: 0.5rem`. */
    gutter: { width: 1.75 * 16, alignItems: "center" },
    itemText: { ...type.body, color: t.text, flex: 1, minWidth: 0 },
  });
