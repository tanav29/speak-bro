import { Button as BaseButton } from "@base-ui/react/button";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex h-9 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-medium shadow-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-transparent bg-white text-zinc-950 hover:bg-zinc-200",
        secondary: "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white",
        ghost: "border-transparent text-zinc-400 hover:bg-white/10 hover:text-white",
        destructive: "border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
      },
      size: {
        default: "px-3",
        sm: "h-8 rounded-md px-2.5 text-xs",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, ...props }) {
  return (
    <BaseButton
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
