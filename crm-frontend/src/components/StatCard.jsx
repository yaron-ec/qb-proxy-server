export default function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`bg-white border border-border p-6 relative overflow-hidden group hover:shadow-lg transition-all duration-200 hover:-translate-y-0.5`}>
      {accent && (
        <div className="absolute top-0 left-0 w-1 h-full bg-orange" />
      )}
      <div className="pl-1">
        <div className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground font-mono mb-2">{label}</div>
        <div className="text-3xl font-black text-midnight tracking-tight">{value}</div>
        {sub && <div className="text-xs font-mono text-muted-foreground mt-1">{sub}</div>}
      </div>
    </div>
  );
}