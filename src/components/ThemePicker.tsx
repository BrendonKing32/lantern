import { useEffect, useState } from "react";
import { THEMES, getTheme, onThemeChange, setTheme, type ThemeId } from "../theme";

export function ThemePicker() {
  const [theme, setLocal] = useState<ThemeId>(getTheme);
  useEffect(() => onThemeChange(setLocal), []);

  return (
    <select
      className="theme-picker"
      aria-label="Theme"
      title="Theme"
      value={theme}
      onChange={(e) => setTheme(e.target.value as ThemeId)}
    >
      {THEMES.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
