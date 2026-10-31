import Slider from "@react-native-community/slider";
import {
  customizationDefaults,
  resolveCustomization,
  type CustomizationField,
  type CustomizationSchema,
  type CustomizationValues,
  type OptionValue,
} from "@tutor/shared/tutor/customization";
import { type Palette } from "@tutor/shared/theme";
import { useMemo, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";

import { useTheme } from "@/theme";
import { Button, Checkbox, Faint, Muted, overlay, radius, Select, space, type } from "@/ui";

/**
 * The "Customize" modal: one generic form for ANY tutor version's options.
 *
 * It knows nothing about TTS, STT or voices. A version declares its options as data
 * (`PromptVersion.customization`, `@tutor/shared/tutor/customization`), and each field kind has one
 * renderer here: `select` → `Select`, `number` → a slider, `boolean` → `Checkbox`. A new version with
 * new fields needs no change in this file. docs/2026-10-30-prompt-version-customization.md §6.
 *
 * Controlled and stateless across opens: the form mounts when the modal opens, so the draft starts
 * from `values` every time, and nothing leaves until Save. Cancel and the back gesture throw the
 * draft away.
 *
 * In `src/lib/` and not `src/app/` for the reason `diagnostics-modal.tsx` gives: expo-router makes
 * every file under `app/` a route.
 */
export function TutorOptionsModal({
  open,
  onOpenChange,
  title,
  schema,
  values,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version's label, shown as the heading. */
  title: string;
  schema: CustomizationSchema;
  /** The saved values, already resolved against `schema`. */
  values: CustomizationValues;
  /** The full resolved draft; the caller stores only what differs from the defaults. */
  onSave: (next: CustomizationValues) => void;
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
      <View style={styles.scrim}>
        <ScrollView contentContainerStyle={styles.viewport}>
          {open ? (
            <OptionsForm
              title={title}
              schema={schema}
              values={values}
              onClose={() => onOpenChange(false)}
              onSave={onSave}
              styles={styles}
            />
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function OptionsForm({
  title,
  schema,
  values,
  onClose,
  onSave,
  styles,
}: {
  title: string;
  schema: CustomizationSchema;
  values: CustomizationValues;
  onClose: () => void;
  onSave: (next: CustomizationValues) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [draft, setDraft] = useState<CustomizationValues>(values);
  const set = (key: string, value: OptionValue) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <View style={styles.popup} accessibilityViewIsModal accessibilityLabel={`Customize ${title}`}>
      <Text style={styles.title}>Customize</Text>
      <Muted style={styles.subtitle}>{title}</Muted>

      {schema.fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          value={draft[field.key]}
          onChange={(v) => set(field.key, v)}
          styles={styles}
        />
      ))}

      <Faint style={styles.note}>Saved on this device. Used from the next session of this tutor.</Faint>

      <View style={styles.actions}>
        <Button
          variant="quiet"
          label="Reset to defaults"
          onPress={() => setDraft(customizationDefaults(schema))}
        />
        <View style={styles.spacer} />
        <Button variant="secondary" label="Cancel" onPress={onClose} />
        <Button
          variant="primary"
          label="Save"
          onPress={() => {
            onSave(resolveCustomization(schema, draft));
            onClose();
          }}
        />
      </View>
    </View>
  );
}

function FieldRow({
  field,
  value,
  onChange,
  styles,
}: {
  field: CustomizationField;
  value: OptionValue | undefined;
  onChange: (next: OptionValue) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const theme = useTheme();
  let control: React.ReactNode;
  let help = field.help;

  switch (field.kind) {
    case "select": {
      const current = typeof value === "string" ? value : field.default;
      const option = field.options.find((o) => o.value === current);
      // An option's own note ("Faster") follows the field's, so the row explains the choice made.
      if (option?.help) help = help ? `${option.help}. ${help}` : option.help;
      control = (
        <Select
          label={field.label}
          value={current}
          onValueChange={onChange}
          options={field.options.map((o) => ({ value: o.value, label: o.label }))}
        />
      );
      break;
    }
    case "number": {
      const current = typeof value === "number" ? value : field.default;
      control = (
        <View style={styles.sliderRow}>
          <Slider
            style={styles.slider}
            minimumValue={field.min}
            maximumValue={field.max}
            step={field.step}
            value={current}
            onValueChange={onChange}
            minimumTrackTintColor={theme.accent}
            maximumTrackTintColor={theme.border}
            accessibilityLabel={field.label}
          />
          <Text style={styles.sliderValue}>
            {formatNumber(current, field.step)}
            {field.unit ?? ""}
          </Text>
        </View>
      );
      break;
    }
    case "boolean": {
      const current = typeof value === "boolean" ? value : field.default;
      control = <Checkbox checked={current} onChange={onChange} accessibilityLabel={field.label} />;
      break;
    }
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{field.label}</Text>
      {control}
      {help ? <Faint style={styles.help}>{help}</Faint> : null}
    </View>
  );
}

/** As many decimals as the step has, so 0.05 steps read "1.05", not "1.0500000001". */
function formatNumber(value: number, step: number): string {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return value.toFixed(decimals);
}

/** The values that differ from the defaults, as one short line — "Men 1 · Qwen3-TTS 0.6B". */
export function customizationSummary(schema: CustomizationSchema, values: CustomizationValues): string {
  return schema.fields
    .filter((f) => values[f.key] !== undefined && values[f.key] !== f.default)
    .map((f) => {
      const v = values[f.key]!;
      switch (f.kind) {
        case "select":
          return f.options.find((o) => o.value === v)?.label ?? String(v);
        case "number":
          return `${formatNumber(v as number, f.step)}${f.unit ?? ""}`;
        case "boolean":
          return `${f.label}: ${v ? "on" : "off"}`;
      }
    })
    .join(" · ");
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
    title: { fontSize: 1.1 * 16, lineHeight: 1.1 * 16 * 1.4, fontWeight: type.weightBold, color: t.text },
    subtitle: { marginTop: 2 },
    field: { marginTop: space.panelPadding, gap: 6 },
    label: { ...type.body, fontWeight: type.weightBold, color: t.text },
    help: { marginTop: 2 },
    sliderRow: { flexDirection: "row", alignItems: "center", gap: space.row },
    slider: { flex: 1, height: 40 },
    sliderValue: { ...type.body, color: t.text, minWidth: 48, textAlign: "right", fontVariant: ["tabular-nums"] },
    note: { marginTop: space.panelPadding },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.row,
      marginTop: space.panelPadding,
    },
    spacer: { flex: 1 },
  });
