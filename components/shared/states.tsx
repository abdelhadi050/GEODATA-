/**
 * GEODATA HUB — empty, error and unauthorized page states (M4).
 * One visual language for the "no data / failed / not allowed" cases.
 */
import Link from "next/link";
import { AlertTriangle, Inbox, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";

function StateShell({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-primary">
        {icon}
      </div>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
  children,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  children?: React.ReactNode;
}) {
  return (
    <StateShell
      icon={<Inbox className="h-6 w-6" />}
      title={title}
      description={description}
      action={
        actionHref && actionLabel ? (
          <Button asChild size="sm">
            <Link href={actionHref}>{actionLabel}</Link>
          </Button>
        ) : (
          children
        )
      }
    />
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
}: {
  title?: string;
  description: string;
}) {
  return (
    <StateShell
      icon={<AlertTriangle className="h-6 w-6 text-destructive" />}
      title={title}
      description={description}
    />
  );
}

export function UnauthorizedState({
  title = "Not permitted",
  description = "Your role does not include the capability required for this area. Contact an organization admin if you need access.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <StateShell
      icon={<ShieldX className="h-6 w-6" />}
      title={title}
      description={description}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      }
    />
  );
}
