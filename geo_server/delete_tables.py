from geo_server.sqlite_wrapper import SQLiteWrapper
import sys

if __name__ == "__main__":
    sqlite_wrapper = SQLiteWrapper("database/geo_chess.db")
    for table in sys.argv[1:]:
        sqlite_wrapper.conn.execute(f"DROP TABLE IF EXISTS {table}")
    sqlite_wrapper.conn.commit()
    sqlite_wrapper.conn.close()
