/**
 * 开关（AGENTS §18.2 共享 UI 件）。
 * 此前设置页、插件配置面板各自写了一份 role="switch" 按钮，样式与无障碍属性容易走样，
 * 这里收敛成一个组件：外部只用 `checked / onChange / ariaLabel`。
 */
export function Switch({
  checked,
  onChange,
  ariaLabel,
  title,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-border"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}
