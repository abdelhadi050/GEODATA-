"use client";

/**
 * GEODATA HUB — geological layer create / edit / delete (M4).
 * Overlap and depth rules are enforced by the service (via the API);
 * the form mirrors the basic constraints and maps envelope errors back.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Plus, Pencil, Trash2 } from "lucide-react";
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
import { apiDelete, apiPatch, apiPost, ApiClientError } from "@/lib/api-client";
import { MATERIAL_TYPES, MATERIAL_TYPE_LABELS } from "@/lib/constants";
import { handleFormError, fieldSetter, validateWithSchema, FieldError } from "@/components/projects/project-form-dialog";
import type { GeologicalLayer } from "@/lib/api-types";

const numberField = (schema: z.ZodType<number>) =>
  z.preprocess(
    (v) => (v === "" || v === null ? undefined : Number(v)),
    z.union([schema, z.undefined()]),
  );

/** Optional field with a pattern: empty string counts as "not provided". */
const optionalPattern = (pattern: RegExp, message: string) =>
  z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.string().trim().max(16).regex(pattern, message).optional(),
  );

const formSchema = z
  .object({
    layerCode: z.string().trim().max(16).optional(),
    materialType: z.enum(MATERIAL_TYPES),
    description: z.string().trim().min(3, "At least 3 characters").max(400),
    uscs: optionalPattern(/^[A-Z]{2}(\([A-Z]\))?$/, "USCS symbol, e.g. CL, SP, SM, GP, CH"),
    consistency: z.string().trim().max(80).optional(),
    depthFrom: numberField(z.number().min(0).max(300)),
    depthTo: numberField(z.number().min(0).max(300)),
  })
  .refine((d) => d.depthTo === undefined || d.depthFrom === undefined || d.depthTo > d.depthFrom, {
    message: "depthTo must be greater than depthFrom",
    path: ["depthTo"],
  });

type FormValues = z.input<typeof formSchema>;

export function LayerFormDialog({
  boreholeId,
  layer,
  variant = "create",
}: {
  boreholeId: string;
  layer?: GeologicalLayer;
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
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: layer
      ? {
          layerCode: layer.layerCode ?? "",
          materialType: layer.materialType as FormValues["materialType"],
          description: layer.description,
          uscs: layer.uscs ?? "",
          consistency: layer.consistency ?? "",
          depthFrom: layer.depthFrom ?? "",
          depthTo: layer.depthTo ?? "",
        }
      : {
          layerCode: "",
          materialType: "SOIL",
          description: "",
          uscs: "",
          consistency: "",
          depthFrom: "",
          depthTo: "",
        },
  });

  async function onSubmit(values: FormValues) {
    if (!validateWithSchema(formSchema, values, fieldSetter(setError))) return;
    setSubmitting(true);
    try {
      const payload = {
        boreholeId,
        layerCode: values.layerCode || undefined,
        materialType: values.materialType,
        description: values.description,
        uscs: values.uscs ? String(values.uscs).toUpperCase() : undefined,
        consistency: values.consistency || undefined,
        depthFrom: Number(values.depthFrom),
        depthTo: Number(values.depthTo),
      };
      if (variant === "create") {
        await apiPost("/api/layers", payload);
        toast({ title: "Layer added" });
      } else if (layer) {
        await apiPatch(`/api/layers/${layer.id}`, payload);
        toast({ title: "Layer updated" });
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      handleFormError(e, fieldSetter(setError), "Layer could not be saved");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {variant === "create" ? (
          <Button size="sm" variant="outline">
            <Plus className="h-4 w-4" /> Add layer
          </Button>
        ) : (
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit layer ${layer?.layerCode ?? ""}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{variant === "create" ? "Add geological layer" : "Edit layer"}</DialogTitle>
          <DialogDescription>
            Depth intervals must not overlap existing layers and must stay within
            the borehole depth.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="layer-from">Depth from (m) *</Label>
              <Input id="layer-from" type="number" step="any" placeholder="0.00" {...register("depthFrom")} />
              <FieldError message={errors.depthFrom?.message as string | undefined} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="layer-to">Depth to (m) *</Label>
              <Input id="layer-to" type="number" step="any" placeholder="2.50" {...register("depthTo")} />
              <FieldError message={errors.depthTo?.message as string | undefined} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="layer-material">Material</Label>
              <Select
                defaultValue={layer?.materialType ?? "SOIL"}
                onValueChange={(v) => setValue("materialType", v as FormValues["materialType"])}
              >
                <SelectTrigger id="layer-material" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MATERIAL_TYPES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {MATERIAL_TYPE_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="layer-code">Layer code</Label>
              <Input id="layer-code" placeholder="e.g. L1 (optional)" {...register("layerCode")} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="layer-uscs">USCS</Label>
              <Input id="layer-uscs" placeholder="CL, SP…" className="font-mono uppercase" {...register("uscs")} />
              <FieldError message={errors.uscs?.message} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="layer-consistency">Consistency</Label>
              <Input id="layer-consistency" placeholder="e.g. stiff (optional)" {...register("consistency")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="layer-description">Description *</Label>
            <Textarea
              id="layer-description"
              rows={2}
              placeholder="Firm brown silty CLAY with fine sand…"
              {...register("description")}
            />
            <FieldError message={errors.description?.message} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : variant === "create" ? "Save layer" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LayerDeleteButton({ layerId, label }: { layerId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    setBusy(true);
    try {
      await apiDelete(`/api/layers/${layerId}`);
      toast({ title: "Layer deleted", description: label });
      router.refresh();
    } catch (e) {
      if (e instanceof ApiClientError) {
        toast({ title: "Layer not deleted", description: e.message, variant: "destructive" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7 text-destructive hover:text-destructive"
      aria-label={`Delete layer ${label}`}
      disabled={busy}
      onClick={() => onDelete()}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  );
}
