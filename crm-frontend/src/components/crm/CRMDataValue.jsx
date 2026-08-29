import { typography } from "@/lib/crmDesignSystem";

export default function CRMDataValue({ children, className = "" }) {
  return (
    <p className={`${typography.dataValue.className} ${className}`}>
      {children}
    </p>
  );
}