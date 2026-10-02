"""Download the latest AI-generated script manifest for a topic from the platform (draft authoring API).

    python fetch_manifest.py --api http://localhost:3000 --token $JWT --topic-id <uuid> > topic.json
    python cli.py build topic.json --out out/ --mock
"""
import argparse, json, sys
import httpx

ap = argparse.ArgumentParser()
ap.add_argument("--api", required=True); ap.add_argument("--token", required=True); ap.add_argument("--topic-id", required=True)
ap.add_argument("--rev", type=int)
a = ap.parse_args()
r = httpx.get(f"{a.api}/v1/authoring/topics/{a.topic_id}/manifest", params={"rev": a.rev} if a.rev else None,
              headers={"Authorization": f"Bearer {a.token}"}, timeout=60)
r.raise_for_status()
body = r.json()
print(f"# rev {body['rev']} job {body['jobId']}", file=sys.stderr)
json.dump(body["manifest"], sys.stdout, ensure_ascii=False, indent=2)
