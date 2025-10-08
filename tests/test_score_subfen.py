from geo_server.get_new_positions import score_subfen
from geo_server.model import GeoChess
from geo_server.sqlite_wrapper import SQLiteWrapper
import sys


def test_score_subfen(puzzle_id: int, sqlite_wrapper: SQLiteWrapper):
    puzzle = sqlite_wrapper.get_geo_chess(puzzle_id)
    score_subfen(puzzle)
    print(puzzle.score)


if __name__ == "__main__":
    sqlite_wrapper = SQLiteWrapper("database/geo_chess.db")
    test_score_subfen(sys.argv[1], sqlite_wrapper)
