import os
import sys

try:
    import redis
except Exception:
    redis = None


def main():
    if redis is None:
        print("redis module not available; nothing to wipe.")
        return 0
    password = os.getenv("REDIS_PASSWORD")
    try:
        r = redis.Redis(host="localhost", port=6379, db=0, password=password)
        # Scan-and-delete keys for percentile cache
        pattern = "geochessr:percentiles:*"
        cursor = 0
        count = 0
        while True:
            cursor, keys = r.scan(cursor=cursor, match=pattern, count=500)
            if keys:
                r.delete(*keys)
                count += len(keys)
            if cursor == 0:
                break
        print(f"Deleted {count} cached percentile entries.")
        return 0
    except Exception as e:
        print(f"Failed to wipe cache: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
