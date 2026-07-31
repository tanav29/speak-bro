import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cn } from "../../lib/utils";

export function Tabs({ className, ...props }) {
  return <BaseTabs.Root className={cn("flex flex-col", className)} {...props} />;
}

export function TabsList({ className, ...props }) {
  return (
    <BaseTabs.List
      className={cn(
        "inline-flex h-9 items-center justify-center gap-0.5 rounded-md border border-white/10 bg-white/[0.03] p-1 text-zinc-400",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }) {
  return (
    <BaseTabs.Tab
      className={cn(
        "inline-flex h-7 cursor-pointer items-center justify-center rounded px-3 text-xs font-medium capitalize outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/20 data-[active]:bg-white data-[active]:text-zinc-950 data-[active]:shadow-sm sm:px-4 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}
