import type { Config } from "tailwindcss";

// 设计令牌映射：组件只写语义类名（bg-app / text-primary …），不写死颜色。
// 用 rgb(var(--x-rgb) / <alpha-value>) 而非 var(--x)：
// 前者才支持 bg-surface/60、ring-accent/30 等透明度修饰；后者会让这些类静默失效。
// 深色模式通过 <html data-theme="dark"> 切换（见 app/theme/ThemeProvider）。
const token = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        "bg-app": token("bg-app"),
        "bg-sidebar": token("bg-sidebar"),
        surface: token("surface"),
        "text-primary": token("text-primary"),
        "text-secondary": token("text-secondary"),
        "text-muted": token("text-muted"),
        accent: token("accent"),
        border: token("border"),
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),
      },
      borderRadius: {
        card: "var(--radius-card)",
        pill: "9999px",
      },
      // 阴影走 CSS 变量，随 data-theme 明暗两套取值（tokens.css）
      boxShadow: {
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
        float: "var(--shadow-float)",
      },
      // 卡片入场动画。用 backwards（而非 both/forwards）：动画结束后不再占用 transform，
      // 否则会盖住 hover:-translate-y-0.5，导致悬浮效果失效。
      keyframes: {
        "card-in": {
          "0%": { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "card-in": "card-in 320ms cubic-bezier(0.22, 1, 0.36, 1) backwards",
      },
    },
  },
  plugins: [],
} satisfies Config;
