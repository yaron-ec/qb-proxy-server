import { button } from "@/lib/crmDesignSystem";

export default function CRMButton({ children, variant = "primary", className = "", ...props }) {
  const buttonStyles = {
    primary: button.primary,
    secondary: button.secondary,
    danger: button.danger,
    success: button.success,
    ghost: button.ghost,
  };

  const baseStyle = buttonStyles[variant] || buttonStyles.primary;

  return (
    <button className={`${baseStyle} ${className}`} {...props}>
      {children}
    </button>
  );
}