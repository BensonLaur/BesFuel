import copy
import importlib.util
import json
import pathlib
from types import SimpleNamespace
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hunan", ROOT / "scripts/read-hunan-xls.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
FIXTURE = json.loads((ROOT / "tests/fixtures/automatic/hunan-cells.json").read_text(encoding="utf-8"))


def workbook(record):
    cells, formats = [], {}
    for row in record["cells"]:
        current = []
        for source in row:
            key = len(formats)
            formats[key] = SimpleNamespace(format_str=source["format"])
            current.append(SimpleNamespace(value=source["value"], ctype=source["ctype"], xf_index=key))
        cells.append(current)
    sheet = SimpleNamespace(nrows=len(cells), ncols=record["cols"],
                            row_values=lambda i: [c.value for c in cells[i]], cell=lambda i, j: cells[i][j])
    return SimpleNamespace(nsheets=1, sheet_by_index=lambda _: sheet,
                           xf_list=[SimpleNamespace(format_key=k) for k in formats], format_map=formats)


class HunanWorkbookTest(unittest.TestCase):
    def test_october_official_xls_retail_prices_and_effective_date(self):
        import xlrd
        file = ROOT / "tests/fixtures/recovery-20261029/hunan-20261029.xls"
        book = xlrd.open_workbook(file, formatting_info=True)
        self.assertEqual(module.extract(book, "2026-10-29"), {"92": 8.83, "95": 9.38, "diesel": 8.66})
        with self.assertRaises(ValueError):
            module.extract(book, "2026-10-28")

    def test_displayed_precision(self):
        self.assertEqual(module.extract(workbook(FIXTURE), FIXTURE["date"]), {"92": 8.55, "95": 9.09, "diesel": 8.37})

    def test_wrong_effective_date(self):
        with self.assertRaises(ValueError):
            module.extract(workbook(FIXTURE), "2026-09-23")

    def test_units_precision_and_scope_must_match(self):
        for row, col, field, value in [(3, 3, "value", "零售最高价（元/吨）"), (5, 3, "format", "0.000"),
                                      (5, 3, "value", 11400.3), (8, 0, "value", "仅长沙适用"),
                                      (5, 3, "ctype", 1), (6, 0, "value", "98号汽油（VIB）")]:
            record = copy.deepcopy(FIXTURE)
            record["cells"][row][col][field] = value
            with self.assertRaises(ValueError):
                module.extract(workbook(record), FIXTURE["date"])


if __name__ == "__main__":
    unittest.main()
