import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/use-auth";
import { Gamepad2, LogOut, Play, Trophy } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

type Best = { score: number; wave: number };

function readBest(): Best {
  try {
    const raw = localStorage.getItem("dd_best");
    const score = Number(raw || 0);
    const wave = Number(localStorage.getItem("dd_best_wave") || 0);
    return { score: isFinite(score) ? score : 0, wave: isFinite(wave) ? wave : 0 };
  } catch {
    return { score: 0, wave: 0 };
  }
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [best] = useState<Best>(() => readBest());

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <main className="min-h-screen bg-background text-foreground studio-grain">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs tracking-[0.28em] uppercase text-muted-foreground">
              Collector's wall
            </p>
            <h1 className="mt-2 font-studio-display text-3xl font-bold tracking-tight sm:text-4xl">
              Welcome{user?.name ? `, ${user.name}` : ""}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              className="rounded-none font-studio-display tracking-[0.16em] uppercase"
              onClick={() => navigate("/game")}
            >
              <Play className="mr-2 size-4" />
              Play now
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-none font-studio-display tracking-[0.16em] uppercase"
              onClick={handleSignOut}
            >
              <LogOut className="mr-2 size-4" />
              Sign out
            </Button>
          </div>
        </header>

        <Separator />

        <div className="grid gap-6 sm:grid-cols-2">
          <Card className="studio-frame rounded-none border-border/80 shadow-none">
            <CardHeader>
              <div className="mb-3 flex size-10 items-center justify-center border border-ink/25 text-ink">
                <Trophy className="size-5" strokeWidth={1.6} />
              </div>
              <CardDescription className="text-xs tracking-[0.22em] uppercase">
                Best run on record
              </CardDescription>
              <CardTitle className="font-studio-display text-4xl tracking-tight">
                {best.score.toLocaleString()}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-6 text-muted-foreground">
              Reached wave <b className="text-foreground">{best.wave || "—"}</b> before
              being erased. Survive wave 5 to pin a checkpoint to the wall.
            </CardContent>
          </Card>

          <Card className="studio-frame rounded-none border-border/80 shadow-none">
            <CardHeader>
              <div className="mb-3 flex size-10 items-center justify-center border border-ink/25 text-ink">
                <Gamepad2 className="size-5" strokeWidth={1.6} />
              </div>
              <CardDescription className="text-xs tracking-[0.22em] uppercase">
                House rules
              </CardDescription>
              <CardTitle className="font-studio-display text-xl tracking-tight">
                How to read the room
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-6 text-muted-foreground">
              Airborne kills pay a third more. The katana charges on three clean
              kills. Wave five brings the first boss — and a checkpoint.
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
