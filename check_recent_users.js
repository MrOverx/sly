const mongoose = require('mongoose');

async function checkUsers() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect('mongodb+srv://mroverx:ankit5639@slydata.qhj9lue.mongodb.net/slyxy?appName=SlyDATA');
    console.log('Connected!');

    const userSchema = new mongoose.Schema({
      userName: String,
      email: String,
      bio: String,
      interests: [String],
      updatedAt: Date
    }, { collection: 'users', strict: false });

    const User = mongoose.model('User', userSchema);

    console.log('Fetching last 5 updated users...');
    const users = await User.find()
      .sort({ updatedAt: -1, lastLogin: -1 })
      .limit(5)
      .select('userName email bio interests updatedAt lastLogin')
      .lean();

    users.forEach(user => {
      console.log(`- ${user.userName} (${user.email})`);
      console.log(`  Bio: ${user.bio}`);
      console.log(`  Interests: ${user.interests ? user.interests.join(', ') : 'None'}`);
      console.log(`  Updated At: ${user.updatedAt}`);
      console.log('---------------------------');
    });

  } catch (err) {
    console.error('Error connecting to db or querying', err);
  } finally {
    await mongoose.connection.close();
    console.log('Disconnected');
  }
}

checkUsers();
