import { useI18n } from "../i18n/I18nProvider";
import { ThemePreference, useTheme } from "../theme/ThemeProvider";

const options: ThemePreference[] = ["light", "dark", "system"];

export default function ThemeSelect({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <label className={`theme-select${compact ? " compact" : ""}`}>
      <span>{t("theme.title")}</span>
      <select
        aria-label={t("theme.title")}
        value={theme}
        onChange={(event) => setTheme(event.target.value as ThemePreference)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {t(`theme.${option}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
