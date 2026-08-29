import { card } from "@/lib/crmDesignSystem";

export default function CRMCard({ children, className = "" }) {
  return (
    <div className={`${card.base} ${card.padding} ${className}`}>
      {children}
    </div>
  );
}