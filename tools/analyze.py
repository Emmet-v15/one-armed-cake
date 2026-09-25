#!/usr/bin/env python3
"""Summarise tools/exp.py results into tables and figures.

    python tools/analyze.py            # reads data/, writes paper/generated/

Per condition, each statistic is summarised across repetitions as the median
and the min-max range; packet losses are summed. Every number in the paper and
README comes from this script, so they can be regenerated from the raw data.
"""
import json
import pathlib
import statistics

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA, OUT = ROOT / "data", ROOT / "paper" / "generated"
FIG = ROOT / "paper" / "figures"


def load(name: str) -> list:
    return [json.loads(line) for line in (DATA / name).read_text().splitlines() if line.strip()]


def group(rows: list) -> dict:
    g: dict = {}
    for r in rows:
        g.setdefault(r["cond"], []).append(r)
    return g


def agg(trials: list, window: str, key: str) -> tuple:
    v = [t[window][key] for t in trials if t[window][key] is not None]
    return statistics.median(v), min(v), max(v)


def cell(trials: list, window: str, key: str) -> str:
    m, lo, hi = agg(trials, window, key)
    return f"{m:.0f} ({lo:.0f}--{hi:.0f})"


def lost(trials: list, window: str) -> int:
    return sum(t[window]["lost"] for t in trials)


def probes(trials: list, window: str) -> int:
    return sum(t[window]["n"] for t in trials)


UP_ORDER = [("up4-none", "4", "none"), ("up4-ef", "4", "EF"), ("up16-none", "16", "none"), ("up16-ef", "16", "EF")]
DOWN_ORDER = [("down-unlimited-rtt100ms-ef", "unlimited", "100", "EF"),
              ("down-5300-rtt30ms-ef", "5300", "30", "EF"), ("down-5100-rtt30ms-ef", "5100", "30", "EF"),
              ("down-4800-rtt30ms-ef", "4800", "30", "EF"), ("down-4500-rtt30ms-ef", "4500", "30", "EF"),
              ("down-4500-rtt30ms-none", "4500", "30", "none")]


def upload_tables(g: dict) -> tuple:
    tex = [r"\begin{tabular}{rl rrr rrr}", r"\toprule",
           r"& & \multicolumn{3}{c}{load start (first 1.5\,s)} & \multicolumn{3}{c}{steady load} \\",
           r"\cmidrule(lr){3-5}\cmidrule(lr){6-8}",
           r"flows & marking & median & max & lost & median & p99 & lost \\", r"\midrule"]
    md = ["| flows | marking | start median | start max | start lost | steady median | steady p99 | steady lost |",
          "|---:|---|---:|---:|---:|---:|---:|---:|"]
    for cond, n, mark in UP_ORDER:
        t = g[cond]
        s_l, s_n, st_l, st_n = lost(t, "start"), probes(t, "start"), lost(t, "steady"), probes(t, "steady")
        tex.append(f"{n} & {mark} & {cell(t,'start','med')} & {cell(t,'start','max')} & {s_l}/{s_n} & "
                   f"{cell(t,'steady','med')} & {cell(t,'steady','p99')} & {st_l}/{st_n} \\\\")
        md.append(f"| {n} | {mark} | {cell(t,'start','med')} | {cell(t,'start','max')} | {s_l}/{s_n} | "
                  f"{cell(t,'steady','med')} | {cell(t,'steady','p99')} | {st_l}/{st_n} |")
    tex += [r"\bottomrule", r"\end{tabular}"]
    return "\n".join(tex), "\n".join(md[:2] + [r.replace("--", "–") for r in md[2:]])


def download_tables(g: dict) -> tuple:
    tex = [r"\begin{tabular}{lrl rrr rrr r}", r"\toprule",
           r"& & & \multicolumn{2}{c}{load start} & & \multicolumn{3}{c}{steady load} & \\",
           r"\cmidrule(lr){4-5}\cmidrule(lr){7-9}",
           r"cap (kbit/s) & rtt & mark & median & p99 & & median & p99 & lost & goodput \\", r"\midrule"]
    md = ["| cap (kbit/s) | rtt (ms) | marking | start median | start p99 | steady median | steady p99 | steady lost | goodput (Mbit/s) |",
          "|---|---:|---|---:|---:|---:|---:|---:|---:|"]
    for cond, cap, rtt, mark in DOWN_ORDER:
        t = g[cond]
        gp = [x["goodput_mbps"] for x in t]
        gps = f"{statistics.median(gp):.2f} ({min(gp):.2f}--{max(gp):.2f})"
        st_l, st_n = lost(t, "steady"), probes(t, "steady")
        tex.append(f"{cap} & {rtt} & {mark} & {cell(t,'start','med')} & {cell(t,'start','p99')} & & "
                   f"{cell(t,'steady','med')} & {cell(t,'steady','p99')} & {st_l}/{st_n} & {gps} \\\\")
        md.append(f"| {cap} | {rtt} | {mark} | {cell(t,'start','med')} | {cell(t,'start','p99')} | "
                  f"{cell(t,'steady','med')} | {cell(t,'steady','p99')} | {st_l}/{st_n} | {gps} |")
    tex += [r"\bottomrule", r"\end{tabular}"]
    return "\n".join(tex), "\n".join(md[:2] + [r.replace("--", "–") for r in md[2:]])


def style() -> None:
    plt.rcParams.update({"font.size": 8, "axes.spines.top": False, "axes.spines.right": False,
                         "axes.grid": True, "grid.alpha": .25, "figure.dpi": 150, "savefig.bbox": "tight"})


def fig_upload(g: dict) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(6.6, 2.4), sharey=True)
    for ax, window, title in ((axes[0], "start", "load start (first 1.5 s)"), (axes[1], "steady", "steady load")):
        for i, (cond, n, mark) in enumerate(UP_ORDER):
            t = g[cond]
            col = "#c0392b" if mark == "none" else "#2471a3"
            ax.scatter([i] * len(t), [x[window]["max"] for x in t], marker="^", s=18, color=col, zorder=3,
                       label="max" if i == 0 else None)
            ax.scatter([i] * len(t), [x[window]["med"] for x in t], marker="o", s=12, facecolors="none",
                       edgecolors=col, zorder=3, label="median" if i == 0 else None)
            lsum = lost(t, window)
            if lsum:
                ax.annotate(f"{lsum} lost", (i, max(x[window]["max"] for x in t)), textcoords="offset points",
                            xytext=(0, 5), ha="center", fontsize=7, color="#c0392b")
        ax.set_xticks(range(4), [f"{n} flows\n{mark}" for _, n, mark in UP_ORDER])
        ax.set_title(title, fontsize=8)
        ax.axhline(50, color="0.5", ls=":", lw=.8)
    axes[0].set_ylabel("probe RTT (ms)")
    axes[0].legend(frameon=False, fontsize=7, loc="upper left")
    fig.savefig(FIG / "upload-start.pdf")
    fig.savefig(FIG / "upload-start.png")


def fig_download(g: dict) -> None:
    ef = [d for d in DOWN_ORDER if d[3] == "EF"]
    labels = [d[1] for d in ef]
    x = range(len(ef))
    fig, ax = plt.subplots(figsize=(4.2, 2.6))
    for key, window, mk, col, lab in (("med", "steady", "o", "#2471a3", "steady median"),
                                      ("p99", "steady", "^", "#2471a3", "steady p99"),
                                      ("p99", "start", "s", "#c0392b", "start p99")):
        ys = [agg(g[d[0]], window, key) for d in ef]
        ax.errorbar(x, [y[0] for y in ys], yerr=[[y[0] - y[1] for y in ys], [y[2] - y[0] for y in ys]],
                    marker=mk, ms=4, lw=1, capsize=2, color=col, ls="-" if key == "med" else "--", label=lab)
    ax.set_xticks(list(x), labels)
    ax.set_xlabel("download cap (kbit/s)")
    ax.set_ylabel("probe RTT (ms)")
    ax.axhline(50, color="0.5", ls=":", lw=.8)
    ax2 = ax.twinx()
    ax2.bar(list(x), [statistics.median([t["goodput_mbps"] for t in g[d[0]]]) for d in ef],
            width=.5, color="0.85", zorder=0, label="goodput")
    ax2.set_ylabel("goodput (Mbit/s)")
    ax2.set_ylim(0, 6)
    ax2.spines["right"].set_visible(True)
    ax.set_zorder(ax2.get_zorder() + 1)
    ax.patch.set_visible(False)
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, frameon=False, fontsize=7, loc="upper right")
    fig.savefig(FIG / "download-sweep.pdf")
    fig.savefig(FIG / "download-sweep.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    style()
    up, down = group(load("results-upload.jsonl")), group(load("results-download.jsonl"))
    ut, um = upload_tables(up)
    dt, dm = download_tables(down)
    (OUT / "table-upload.tex").write_text(ut, encoding="utf-8")
    (OUT / "table-download.tex").write_text(dt, encoding="utf-8")
    (OUT / "tables.md").write_text("## Upload start\n\n" + um + "\n\n## Download cap sweep\n\n" + dm + "\n",
                                   encoding="utf-8")
    idle = [t["idle"]["med"] for rows in (up, down) for ts in rows.values() for t in ts if t["idle"]["med"]]
    (OUT / "numbers.tex").write_text(
        f"\\newcommand{{\\idleMedian}}{{{statistics.median(idle):.1f}}}\n"
        f"\\newcommand{{\\nTrials}}{{{sum(len(v) for v in up.values()) + sum(len(v) for v in down.values())}}}\n",
        encoding="utf-8")
    fig_upload(up)
    fig_download(down)
    print((OUT / "tables.md").read_text(encoding="utf-8").encode("ascii", "replace").decode())
    print(f"\nidle median across all trials: {statistics.median(idle):.1f} ms")


if __name__ == "__main__":
    main()
