"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { BrandMark } from "@/components/layout/brand-mark";
import { NAV_GROUPS } from "@/components/layout/nav-config";
import { can } from "@/lib/rbac";

export function AppSidebar({ role }: { role: string }) {
  const pathname = usePathname();
  return (
    <Sidebar>
      <SidebarHeader>
        <BrandMark />
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter(
            (item) => !item.capability || can(role, item.capability),
          );
          if (visible.length === 0) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {visible.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={
                          pathname === item.href ||
                          (item.href !== "/dashboard" &&
                            pathname.startsWith(`${item.href}/`))
                        }
                        tooltip={item.description}
                      >
                        <Link href={item.href}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}
