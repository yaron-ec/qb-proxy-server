import { card, typography } from "@/lib/crmDesignSystem";

export default function CRMMetricCard({ label, value, className = "" }) {
  return (
    <div className={`${card.base} ${card.padding} ${className}`}>
      <p className={`${typography.fieldLabel.className} mb-1.5`}>{label}</p>
      <p className={typography.metricValue.className}>{value}</p>
    </div>
  );
}