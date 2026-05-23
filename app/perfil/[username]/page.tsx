import { PHOTOS } from '@/data/photos';
import { notFound } from 'next/navigation';

export default function Profile({ params }: { params: { username: string } }) {
  const username = decodeURIComponent(params.username);
  const userPhotos = PHOTOS.filter(p => p.username === username);
  if (userPhotos.length === 0) notFound();

  return (
    <>
      <header>caribook</header>
      <div className="profile-header">
        <div className="avatar" style={{ width: 90, height: 90, fontSize: 36, margin: '0 auto' }}>
          {username[0].toUpperCase()}
        </div>
        <div className="profile-name">{username}</div>
      </div>
      <div className="feed">
        {userPhotos.map(p => (
          <article key={p.id} className="post">
            <div className="post-caption" style={{ paddingTop: 14 }}>{p.caption}</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="post-img" src={`/photos/${p.filename}`} alt={p.caption} />
            <div className="post-caption time">{new Date(p.postedAt).toLocaleString('es-CO')}</div>
          </article>
        ))}
      </div>
    </>
  );
}
