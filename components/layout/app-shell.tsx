"use client";

import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { UserMenu } from "@/components/layout/user-menu";
import { ROLE_LABELS } from "@/lib/constants";
import type { Role } from "@/lib/constants";
import type { SessionUser } from "@/lib/auth";

export function AppShell({
  user,
  orgName,
  children,
}: {
  user: SessionUser;
  orgName: string;
  children: React.ReactNode;
}) {
  const roleLabel = ROLE_LABELS[user.role as Role] ?? user.role;
  return (
    <SidebarProvider>
      <AppSidebar role={user.role} />
      <SidebarInset>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <SidebarTrigger aria-label="Toggle navigation" />
          <Breadcrumbs />
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-1 hidden text-xs text-muted-foreground lg:inline">
              {orgName}
            </span>
            <ThemeSwitcher />
            <UserMenu user={user} orgName={orgName} roleLabel={roleLabel} />
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
