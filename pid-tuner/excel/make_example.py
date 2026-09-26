# Example workbook with synthetic data shaped like the real 3FC1301B case (PI-compressed, flow in CAS,
# ~15 min oscillation). For learning the layout only; not plant data.
import math
from datetime import datetime, timedelta

import make_workbook as mw


def example_rows():
    t0 = datetime(2026, 9, 26, 7, 48, 0)
    knots = []
    for k in range(7200 // 120 + 2):
        ph = k * 120 / 876 * 2 * math.pi
        knots.append((78 + 2.5 * math.sin(ph) + 0.8 * math.sin(k * 7.3), 78.5 + 1.2 * math.sin(k * 120 / 1800), 22.8 + 1.3 * math.sin(ph - 1.2)))
    rows = []
    for i in range(7200):
        k, f = divmod(i, 120)
        a, b = knots[k], knots[k + 1]
        v = [a[j] + (b[j] - a[j]) * f / 120 for j in range(3)]
        rows.append((t0 + timedelta(seconds=i), round(v[0], 5), round(v[1], 5), round(v[2], 5), "Tag not found" if i < 2 else None))
    return rows


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "PI_Loop_Health_Example.xlsx"
    mw.build(out, data=example_rows())
    print("saved", out)
