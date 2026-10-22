import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("documents", ROOT / "scripts/read-price-document.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
FIXTURES = ROOT / "tests/fixtures/automatic/documents"
DAY = "2026-09-24"


class OfficialDocumentTest(unittest.TestCase):
    def test_real_official_documents_match_independently_verified_prices(self):
        for group, name in [("jilin", "jilin.pdf"), ("yunnan", "yunnan.pdf"), ("sichuan", "sichuan.docx")]:
            text, rows = module.read_docx(FIXTURES / name) if group == "sichuan" else module.read_pdf(FIXTURES / name)
            parsed = getattr(module, "parse_" + group)(text, rows, DAY)
            for key, prices in parsed.items():
                record = json.loads((ROOT / "data/verified" / (key + ".json")).read_text(encoding="utf-8"))
                expected = next(n["prices"] for n in record["notices"] if n["publishedDate"] == DAY)
                self.assertEqual(prices, expected, key)

    def test_pdf_effective_date_must_match_its_announcement(self):
        for group in ["jilin", "yunnan"]:
            with self.assertRaisesRegex(ValueError, "生效日"):
                getattr(module, "parse_" + group)(*module.read_pdf(FIXTURES / (group + ".pdf")), "2026-09-23")

    def test_jilin_never_substitutes_ton_prices_or_another_diesel_grade(self):
        text, rows = module.read_pdf(FIXTURES / "jilin.pdf")
        for row, col, value in [(0, 4, "每吨最高零售价(元)"), (3, 4, "11331"), (3, 0, "98#乙醇汽油"),
                                (6, 0, "-10#车用柴油（标准品）"), (3, 4, "8.570")]:
            mutated = copy.deepcopy(rows)
            mutated[row][col] = value
            with self.assertRaises(ValueError):
                module.parse_jilin(text, mutated, DAY)

    def test_yunnan_requires_exact_units_regions_and_cell_merges(self):
        text, rows = module.read_pdf(FIXTURES / "yunnan.pdf")
        for row, col, value in [(0, 5, "调整后零售价(元/吨)"), (1, 6, "95#Ⅵ汽油"),
                                (3, 0, "昆明"), (4, 6, "8.83"), (3, 6, None)]:
            mutated = copy.deepcopy(rows)
            mutated[row][col] = value
            with self.assertRaises(ValueError):
                module.parse_yunnan(text, mutated, DAY)

    def test_sichuan_rejects_changed_zone_definition_or_wholesale_column(self):
        text, rows = module.read_docx(FIXTURES / "sichuan.docx")
        with self.assertRaises(ValueError):
            module.parse_sichuan(text.replace("为二价区", "为一价区"), rows, DAY)
        for row, col, value in [(0, 2, "一价区"), (1, 4, "最高批发价格"), (2, 6, "元/吨"), (4, 6, "11665")]:
            mutated = copy.deepcopy(rows)
            mutated[row][col] = value
            with self.assertRaises(ValueError):
                module.parse_sichuan(text, mutated, DAY)


if __name__ == "__main__":
    unittest.main()
