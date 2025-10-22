from geo_server.sqlite_wrapper import SQLiteWrapper
from geo_server.model import GeoChess, ChessGame, RunSettings, Run
import time
from sqlite3 import IntegrityError
from datetime import datetime, timedelta
from geo_server.get_new_positions import add_geochess_to_database
import string
import secrets
from geo_server.constants import metadata_fields as SOURCE_METADATA_FIELDS

daily_run_settings = RunSettings(
    min_difficulty=None,
    max_difficulty=None,
    min_difficulty_percentage=0.0,
    max_difficulty_percentage=0.5,
    min_score=6.0,
    n_puzzles=5,
    max_move_num=20,
    min_move_num=4,
    black_info_rate=0.2,
    source="lichess",
)


def create_daily_run(
    sqlite_wrapper: SQLiteWrapper,
    grab_new_tournaments: bool = True,
    source: str = "lichess",
) -> Run:
    if source == "lichess":
        daily_run_settings.early_timestamp = int(
            (datetime.now() - timedelta(days=1)).timestamp()
        )
    daily_run_settings.source = source
    daily_run_settings.metadata_fields = SOURCE_METADATA_FIELDS[source]
    if grab_new_tournaments:
        try:
            add_geochess_to_database(sqlite_wrapper, n_tournaments=3)
        except Exception as e:
            print(f"Failed to add geochess to database: {e}")
    sqlite_wrapper.remove_daily_run()
    if source == "lichess":
        try:
            stuff = sqlite_wrapper.select_geo_chess_for_run(daily_run_settings)
            if len(stuff) < 5:
                print("Failed to get 5 geochess")
                daily_run_settings.early_timestamp = None
        except Exception:
            print("Failed to create runs with new timestamps")
            daily_run_settings.early_timestamp = None

    return create_run_and_add_to_database(sqlite_wrapper, daily_run_settings, True)


def create_run_and_add_to_database(
    sqlite_wrapper: SQLiteWrapper, run_settings: RunSettings, is_daily: bool
) -> Run:
    geochess_list = sqlite_wrapper.select_geo_chess_for_run(run_settings)
    if len(geochess_list) == 0 and is_daily:
        print("No geochess found")
        run_settings = daily_run_settings.model_copy()
        run_settings.source = "world_champion"
        geochess_list = sqlite_wrapper.select_geo_chess_for_run(run_settings)

    for _ in range(10):
        try:
            run = Run(
                identifier="".join(
                    secrets.choice(string.ascii_uppercase) for _ in range(8)
                ),
                puzzle_ids=[geochess.id for geochess in geochess_list],
                is_daily=is_daily,
                black_info_rate=run_settings.black_info_rate,
                metadata_fields=run_settings.metadata_fields,
            )
            sqlite_wrapper.insert_run(run)
        except IntegrityError as e:
            print(f"IntegrityError: {e}")
            continue
        break
    else:
        raise Exception("Failed to create run")
    return run


if __name__ == "__main__":
    sqlite_wrapper = SQLiteWrapper("database/geo_chess.db")
    create_daily_run(
        sqlite_wrapper, grab_new_tournaments=False, source="world_champion"
    )
