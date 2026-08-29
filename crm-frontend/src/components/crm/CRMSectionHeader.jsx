import { typography } from "@/lib/crmDesignSystem";

export default function CRMSectionHeader({ children, className = "" }) {
  return (
    <p className={`${typography.sectionHeader.className} ${className}`}>
      {children}
    </p>
  );
}