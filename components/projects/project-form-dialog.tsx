"use client";

/**
 * GEODATA HUB — project create / edit dialog (M4).
 *
 * Client-side validation mirrors the shared M2 rules for instant feedback;
 * the submitted payload is re-validated by the API (authoritative), and
 * server field errors from the envelope are mapped back onto the form.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, type FieldPath, type FieldValues, type UseFormSetError } from "react-hook-form";
import { z } from "zod";
import { Plus, Pencil } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS } from "@/lib/constants";
import type { ProjectListItem } from "@/lib/api-types";

/** Empty string → undefined so optional numbers stay optional. */
const optionalNumber = z.preprocess(
  (v) => (v === "" || v === null ? undefined : Number(v)),
  z.union([z.number().min(-90).max(90).optional(), z.undefined()]),
);

const formSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "2–24 characters")
    .max(24)
    .regex(
      /^[A-Z0-9][A-Z0-9_-]*$/,
      "Uppercase letters, digits, dashes or underscores",
    ),
  name: z.string().trim().min(3, "At least 3 characters").max(120),
  description: z.string().trim().max(2000).optional(),
  client: z.string().trim().max(120).optional(),
  status: z.enum(PROJECT_STATUSES),
  locationName: z.string().trim().max(120).optional(),
  latitude: optionalNumber,
  longitude: optionalNumber,
});

type FormValues = z.input<typeof formSchema>;

const EMPTY: FormValues = {
  code: "",
  name: "",
  description: "",
  client: "",
  status: "ACTIVE",
  locationName: "",
  latitude: "",
  longitude: "",
};

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

/** Adapt a typed react-hook-form setError to the generic string-field setter. */
export function fieldSetter<T extends FieldValues>(
  setError: UseFormSetError<T>,
): (field: string, error: { message: string }) => void {
  return (field, err) => setError(field as FieldPath<T>, err);
}

/**
 * Client-side validation with the shared Zod schema — mirrors the API rules
 * for instant feedback; issues are mapped onto form fields.
 * Returns true when valid.
 */
export function validateWithSchema(
  schema: z.ZodType,
  values: unknown,
  setError: (field: string, error: { message: string }) => void,
): boolean {
  const parsed = schema.safeParse(values);
  if (parsed.success) return true;
  for (const issue of parsed.error.issues) {
    setError(issue.path.join("."), { message: issue.message });
  }
  return false;
}

/** Shared error mapping for all form dialogs. */
export function handleFormError(
  error: unknown,
  setError: (field: string, error: { message: string }) => void,
  fallbackTitle: string,
) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      toast({
        title: "Session expired",
        description: "Please sign in again.",
        variant: "destructive",
      });
      window.location.href = "/login";
      return;
    }
    const fieldErrors = error.fieldErrors;
    for (const [path, message] of Object.entries(fieldErrors)) {
      setError(path, { message });
    }
    toast({
      title: error.code === "VALIDATION_ERROR" ? "Validation failed" : fallbackTitle,
      description: Object.values(fieldErrors)[0] ?? error.message,
      variant: "destructive",
    });
    return;
  }
  toast({ title: fallbackTitle, description: "Unexpected error", variant: "destructive" });
}

export function ProjectFormDialog({
  project,
  variant = "create",
}: {
  project?: ProjectListItem;
  variant?: "create" | "edit";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: project
      ? {
          code: project.code,
          name: project.name,
          description: project.description ?? "",
          client: project.client ?? "",
          status: (project.status as FormValues["status"]) ?? "ACTIVE",
          locationName: project.locationName ?? "",
          latitude: project.latitude ?? "",
          longitude: project.longitude ?? "",
        }
      : EMPTY,
  });

  async function onSubmit(values: FormValues) {
    if (!validateWithSchema(formSchema, values, fieldSetter(setError))) return;
    setSubmitting(true);
    try {
      const payload = {
        code: values.code,
        name: values.name,
        description: values.description || undefined,
        client: values.client || undefined,
        status: values.status,
        locationName: values.locationName || undefined,
        latitude:
          values.latitude === "" || values.latitude == null
            ? undefined
            : Number(values.latitude),
        longitude:
          values.longitude === "" || values.longitude == null
            ? undefined
            : Number(values.longitude),
      };
      if (variant === "create") {
        const res = await apiPost<{ id: string; code: string; name: string }>(
          "/api/projects",
          payload,
        );
        toast({
          title: "Project created",
          description: `${res.data.code} — ${res.data.name}`,
        });
        setOpen(false);
        reset(EMPTY);
        router.push(`/projects/${res.data.id}`);
      } else if (project) {
        await apiPatch(`/api/projects/${project.id}`, payload);
        toast({ title: "Project updated", description: project.code });
        setOpen(false);
        router.refresh();
      }
    } catch (e) {
      handleFormError(e, fieldSetter(setError), "Project could not be saved");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {variant === "create" ? (
          <Button size="sm">
            <Plus className="h-4 w-4" /> New project
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Pencil className="h-4 w-4" /> Edit
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {variant === "create" ? "New project" : `Edit ${project?.code}`}
          </DialogTitle>
          <DialogDescription>
            {variant === "create"
              ? "Register a geotechnical investigation project in your organization."
              : "Update project metadata. The organization cannot be changed."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-code">Code</Label>
              <Input
                id="project-code"
                placeholder="BLIDA-2026"
                className="font-mono uppercase"
                disabled={variant === "edit"}
                {...register("code")}
              />
              <FieldError message={errors.code?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-status">Status</Label>
              <Select
                defaultValue={project?.status ?? "ACTIVE"}
                onValueChange={(v) => setValue("status", v as FormValues["status"])}
              >
                <SelectTrigger id="project-status" className="w-full">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {PROJECT_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.status?.message} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              placeholder="Blida Ring Road — Geotechnical Study"
              {...register("name")}
            />
            <FieldError message={errors.name?.message} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-client">Client</Label>
              <Input id="project-client" placeholder="Client (optional)" {...register("client")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-location">Location</Label>
              <Input
                id="project-location"
                placeholder="Location name (optional)"
                {...register("locationName")}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-lat">Latitude</Label>
              <Input
                id="project-lat"
                type="number"
                step="any"
                placeholder="36.47"
                {...register("latitude")}
              />
              <FieldError message={errors.latitude?.message as string | undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-lng">Longitude</Label>
              <Input
                id="project-lng"
                type="number"
                step="any"
                placeholder="2.83"
                {...register("longitude")}
              />
              <FieldError message={errors.longitude?.message as string | undefined} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              rows={3}
              placeholder="Scope, objectives, constraints (optional)"
              {...register("description")}
            />
            <FieldError message={errors.description?.message} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : variant === "create" ? "Create project" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
