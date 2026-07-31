import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "../../lib/utils";

export function Input({ className, ...props }) {
  return (
    <BaseInput
      className={cn(
        "flex h-10 w-full rounded-md border border-white/10 bg-transparent px-3 py-2 text-sm text-white outline-none transition-colors placeholder:text-zinc-500 focus:border-white/30 focus:ring-2 focus:ring-white/10 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
