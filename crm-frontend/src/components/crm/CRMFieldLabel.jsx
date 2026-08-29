import { typography } from "@/lib/crmDesignSystem";

export default function CRMFieldLabel({ children, className = "" }) {
  return (
    <p className={`${typography.fieldLabel.className} ${className}`}>
      {children}
    </p>
  );
}