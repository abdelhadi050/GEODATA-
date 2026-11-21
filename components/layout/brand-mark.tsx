export function BrandMark() {
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-bold">
        GH
      </div>
      <div className="flex flex-col leading-none">
        <span className="text-sm font-semibold tracking-tight">GEODATA HUB</span>
        <span className="text-[10px] text-muted-foreground">
          Geotechnical &amp; GIS
        </span>
      </div>
    </div>
  );
}
