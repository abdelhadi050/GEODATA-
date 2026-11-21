"use client";

import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      onClick={() => {
        void signOut({ redirect: false }).finally(() => {
          router.push("/login");
          router.refresh();
        });
      }}
    >
      Sign out
    </Button>
  );
}
